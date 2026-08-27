import { createHmac, randomUUID } from 'node:crypto';

import {
  canonicalJsonValue,
  type RuntimeAgent,
  type RuntimeArtifactReference,
  type RuntimeEnvironment,
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeFileResource,
  type RuntimeHandle,
  type RuntimeObservedCommand,
  type RuntimeOutput,
  type RuntimeProvider,
  type RuntimeStartRequest,
  type RuntimeUsage,
} from '@agentos/core';
import { z } from 'zod';

import { ARTIFACT_MCP_PROTOCOL_VERSION } from '../artifacts/mcp.js';
import { runKimiAgentLoop } from './loop.js';
import { createKimiSandbox, type KimiSandbox } from './sandbox.js';
import { createKimiHttpTransport } from './transport.js';
import type {
  KimiLoopResult,
  KimiToolDefinition,
  KimiToolExecutor,
  KimiTransport,
} from './types.js';

/**
 * Thrown for provider-level configuration and fail-closed validation
 * failures: bad constructor options, an unknown agentId/environmentId at
 * start, resources without a resolver, credentialRefs without artifactMcp,
 * and session-identity conflicts.
 */
export class KimiRuntimeProviderError extends Error {
  override readonly name = 'KimiRuntimeProviderError';

  constructor(
    message: string,
    readonly code?: 'runtime_session_missing',
  ) {
    super(message);
  }
}

export interface KimiRuntimeProviderOptions {
  readonly apiKey: string;
  readonly ownershipSecret: string; // >= 32 bytes
  readonly sandboxRoot: string;
  readonly baseUrl?: string;
  readonly transport?: KimiTransport; // test seam; default createKimiHttpTransport
  readonly resolveFile?: (fileId: string) => Promise<Uint8Array>; // resolves RuntimeFileResource fileIds
  readonly artifactMcp?: {
    readonly url: string; // AGENTOS_ARTIFACT_MCP_URL
    readonly resolveCredential: (ref: string) => Promise<string>; // credentialRef -> bearer capability
    readonly fetchImpl?: typeof fetch; // test seam
  };
  // Invoked by cleanupAccess() so whatever staged `resources`/`credentialRefs`
  // (e.g. a local KimiLocalAccessStore's entries) can be released once a
  // session's access is no longer needed. Optional: a caller with nothing to
  // release (e.g. resources were never staged locally) simply omits it.
  readonly accessCleanup?: (input: {
    readonly resources: readonly RuntimeFileResource[];
    readonly credentialRefs: readonly string[];
  }) => void;
  readonly clock?: () => string;
}

export function createKimiRuntimeProvider(
  options: KimiRuntimeProviderOptions,
): RuntimeProvider {
  return new KimiRuntimeProviderImpl(validateOptions(options));
}

// --- tool definitions -------------------------------------------------

/**
 * Hard ceiling on the agent-supplied `bash` timeout. The tool call holds the
 * per-session mutex for its whole duration -- the same mutex `cleanup()`'s
 * workdir destroy and `observeCommand` wait on -- so an unbounded,
 * model-chosen timeout would let the agent park the session indefinitely.
 * Advertised in the tool schema and clamped again in the executor, since a
 * model is free to ignore the schema.
 */
const MAX_BASH_TIMEOUT_MS = 120_000;

const BASH_TOOL: KimiToolDefinition = {
  name: 'bash',
  description: 'Run a bash command in the sandbox working directory.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_BASH_TIMEOUT_MS,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

const READ_TOOL: KimiToolDefinition = {
  name: 'read',
  description: 'Read a UTF-8 text file from the sandbox (max 1 MiB).',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

const WRITE_TOOL: KimiToolDefinition = {
  name: 'write',
  description:
    'Write a UTF-8 text file in the sandbox, creating parent directories as needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};

const EDIT_TOOL: KimiToolDefinition = {
  name: 'edit',
  description:
    'Replace exactly one occurrence of oldText with newText in a sandbox file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldText: { type: 'string' },
      newText: { type: 'string' },
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false,
  },
};

const SUBMIT_RESULT_TOOL: KimiToolDefinition = {
  name: 'submit_result',
  description: 'Submit the final JSON result and end the session.',
  input_schema: { type: 'object', additionalProperties: true },
};

const ARTIFACT_PUT_TOOL: KimiToolDefinition = {
  name: 'artifact_put',
  description:
    'Store an immutable content-addressed artifact via the Artifact MCP.',
  input_schema: {
    type: 'object',
    properties: {
      artifactId: { type: 'string' },
      version: { type: 'integer', minimum: 1 },
      mediaType: { type: 'string' },
      contentBase64: { type: 'string' },
      digest: { type: 'string' },
      retentionClass: {
        enum: ['source-bundle', 'cloud-session-upload', 'working'],
      },
    },
    required: ['artifactId', 'version', 'mediaType', 'contentBase64'],
    additionalProperties: false,
  },
};

const ARTIFACT_GET_TOOL: KimiToolDefinition = {
  name: 'artifact_get',
  description: 'Read one immutable artifact via the Artifact MCP.',
  input_schema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
};

// --- tool input schemas -------------------------------------------------

const bashInputSchema = z
  .object({
    command: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const readInputSchema = z.object({ path: z.string() }).strict();

const writeInputSchema = z
  .object({ path: z.string(), content: z.string() })
  .strict();

const editInputSchema = z
  .object({ path: z.string(), oldText: z.string(), newText: z.string() })
  .strict();

const artifactPutInputSchema = z
  .object({
    artifactId: z.string(),
    version: z.number().int().min(1),
    mediaType: z.string(),
    contentBase64: z.string(),
    digest: z.string().optional(),
    retentionClass: z
      .enum(['source-bundle', 'cloud-session-upload', 'working'])
      .optional(),
  })
  .strict();

const artifactGetInputSchema = z.object({ key: z.string() }).strict();

// --- session state -------------------------------------------------

type KimiSessionStatus =
  'running' | 'submitted' | 'turn_limit' | 'cancelled' | 'failed';

interface KimiSession {
  readonly handle: RuntimeHandle;
  readonly runId: string;
  readonly stepId: string;
  readonly agentId: string;
  readonly sandbox: KimiSandbox;
  readonly controller: AbortController;
  readonly startedAtMs: number;
  readonly credentialRef: string | undefined;
  events: RuntimeEvent[];
  waiters: Array<() => void>;
  loopPromise: Promise<KimiLoopResult>;
  usage: { inputTokens: number; outputTokens: number };
  result: unknown;
  failure: unknown;
  status: KimiSessionStatus;
  nextEventSeq: number;
  mutex: Promise<void>;
  putArtifacts: RuntimeArtifactReference[];
  pendingUserTurns: unknown[];
}

interface ResolvedArtifactMcp {
  readonly url: string;
  readonly resolveCredential: (ref: string) => Promise<string>;
  readonly fetchImpl: typeof fetch;
}

interface ValidatedOptions {
  readonly transport: KimiTransport;
  readonly sandboxRoot: string;
  readonly ownershipSecret: string;
  readonly resolveFile: ((fileId: string) => Promise<Uint8Array>) | undefined;
  readonly artifactMcp: ResolvedArtifactMcp | undefined;
  readonly accessCleanup:
    | ((input: {
        readonly resources: readonly RuntimeFileResource[];
        readonly credentialRefs: readonly string[];
      }) => void)
    | undefined;
  readonly clock: () => string;
}

const TERMINAL_STATUSES: ReadonlySet<KimiSessionStatus> = new Set([
  'submitted',
  'turn_limit',
  'cancelled',
  'failed',
]);

function isTerminal(status: KimiSessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

class KimiRuntimeProviderImpl implements RuntimeProvider {
  readonly #transport: KimiTransport;
  readonly #sandboxRoot: string;
  readonly #ownershipSecret: string;
  readonly #resolveFile: ((fileId: string) => Promise<Uint8Array>) | undefined;
  readonly #artifactMcp: ResolvedArtifactMcp | undefined;
  readonly #accessCleanup:
    | ((input: {
        readonly resources: readonly RuntimeFileResource[];
        readonly credentialRefs: readonly string[];
      }) => void)
    | undefined;
  readonly #clock: () => string;
  readonly #agents = new Map<string, RuntimeAgent>();
  readonly #environments = new Map<string, RuntimeEnvironment>();
  readonly #sessions = new Map<string, KimiSession>();

  constructor(options: ValidatedOptions) {
    this.#transport = options.transport;
    this.#sandboxRoot = options.sandboxRoot;
    this.#ownershipSecret = options.ownershipSecret;
    this.#resolveFile = options.resolveFile;
    this.#artifactMcp = options.artifactMcp;
    this.#accessCleanup = options.accessCleanup;
    this.#clock = options.clock;
  }

  async syncAgent(agent: RuntimeAgent): Promise<void> {
    this.#agents.set(agent.id, agent);
  }

  async syncEnvironment(environment: RuntimeEnvironment): Promise<void> {
    this.#environments.set(environment.id, environment);
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    const agent = this.#agents.get(request.agentId);
    if (agent === undefined) {
      throw new KimiRuntimeProviderError(`unknown agentId: ${request.agentId}`);
    }
    if (this.#environments.get(request.environmentId) === undefined) {
      throw new KimiRuntimeProviderError(
        `unknown environmentId: ${request.environmentId}`,
      );
    }
    const resources = request.resources ?? [];
    if (resources.length > 0 && this.#resolveFile === undefined) {
      throw new KimiRuntimeProviderError(
        'request.resources require a resolveFile resolver',
      );
    }
    const credentialRefs = request.credentialRefs ?? [];
    if (credentialRefs.length > 0 && this.#artifactMcp === undefined) {
      throw new KimiRuntimeProviderError(
        'request.credentialRefs require artifactMcp configuration',
      );
    }
    if (
      request.timeoutMs !== undefined &&
      (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
    ) {
      throw new KimiRuntimeProviderError(
        'request.timeoutMs must be a positive integer',
      );
    }

    const sessionId = deriveSessionId(
      this.#ownershipSecret,
      request.runId,
      request.stepId,
    );
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      if (existing.agentId !== request.agentId) {
        throw new KimiRuntimeProviderError(
          'a session already exists for this runId/stepId with a different agentId',
        );
      }
      return existing.handle;
    }

    const sandbox = await createKimiSandbox({
      root: this.#sandboxRoot,
      sessionId,
    });
    if (resources.length > 0) {
      const resolveFile = this.#resolveFile!;
      // The workdir already exists at this point, so any failure while
      // resolving or writing the mounted files (an unknown file id, a mount
      // path the sandbox rejects, a disk error) must destroy it before
      // rethrowing -- start() never returns a handle here, so nothing else
      // would ever be able to clean it up.
      try {
        const materialized = await Promise.all(
          resources.map(async (resource) => ({
            path: resource.mountPath ?? resource.fileId,
            content: await resolveFile(resource.fileId),
          })),
        );
        await sandbox.materialize(materialized);
      } catch (error) {
        await sandbox.destroy().catch(() => undefined);
        throw error;
      }
    }

    const handle: RuntimeHandle = Object.freeze({ id: sessionId });
    const controller = new AbortController();
    const session: KimiSession = {
      handle,
      runId: request.runId,
      stepId: request.stepId,
      agentId: request.agentId,
      sandbox,
      controller,
      startedAtMs: Date.parse(this.#clock()),
      credentialRef: credentialRefs[0],
      events: [],
      waiters: [],
      // Placeholder; replaced immediately below once the executor exists.
      loopPromise: Promise.resolve({
        status: 'cancelled',
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
      }),
      usage: { inputTokens: 0, outputTokens: 0 },
      result: undefined,
      failure: undefined,
      status: 'running',
      nextEventSeq: 0,
      mutex: Promise.resolve(),
      putArtifacts: [],
      pendingUserTurns: [],
    };

    const tools: KimiToolDefinition[] = [
      BASH_TOOL,
      READ_TOOL,
      WRITE_TOOL,
      EDIT_TOOL,
      SUBMIT_RESULT_TOOL,
      ...(credentialRefs.length > 0
        ? [ARTIFACT_PUT_TOOL, ARTIFACT_GET_TOOL]
        : []),
    ];
    const executor = buildExecutor(session, this.#artifactMcp);

    this.#sessions.set(sessionId, session);
    session.loopPromise = runKimiAgentLoop({
      transport: this.#transport,
      model: agent.model,
      ...(agent.instructions === undefined
        ? {}
        : { system: agent.instructions }),
      initialInput: request.input,
      tools,
      executor,
      signal: controller.signal,
      onEvent: (event) =>
        this.#emit(session, event.type, { detail: event.detail }),
      // Per-turn, not just at settlement: a cancelled session's usage() has
      // to report the tokens it actually spent. Assigned unconditionally --
      // the totals are cumulative and monotonic for the life of the loop, so
      // a turn that lands after cancellation only ever adds real spend (it
      // can never revive or lower a terminal session's snapshot).
      onUsage: (usage) => {
        session.usage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        };
      },
    }).then(
      (result) => {
        // A concurrent cancel()/cleanup()/timeout may have already
        // finalized this session (and emitted its own terminal event)
        // while this turn was in flight; #terminate no-ops in that case so
        // a late turn can never resurrect a cancelled run or overwrite its
        // final usage snapshot with whatever this stale turn reports.
        const alreadyTerminal = isTerminal(session.status);
        if (!alreadyTerminal) {
          session.usage = {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          };
        }
        if (result.status === 'submitted') {
          if (
            this.#terminate(session, 'submitted', 'terminated', {
              reason: 'submitted',
            })
          ) {
            session.result = result.result;
          }
        } else if (result.status === 'turn_limit') {
          this.#terminate(session, 'turn_limit', 'error', {
            reason: 'turn_limit',
          });
        } else {
          this.#terminate(session, 'cancelled', 'terminated', {
            reason: 'cancelled',
          });
        }
        return result;
      },
      (error: unknown) => {
        const message = errorMessage(error);
        if (this.#terminate(session, 'failed', 'error', { message })) {
          // Keep the original typed error for collectOutput(). Workflow
          // retry classification depends on transport status/code fields;
          // reducing the failure to display text makes transient upstream
          // faults look permanent.
          session.failure = error;
        }
        throw error;
      },
    );
    // Attach a handler immediately so a routine transport failure (or a
    // cancellation the transport never actually cancels) never surfaces as
    // an unhandled promise rejection; later `await session.loopPromise`
    // call sites (collectOutput, cleanup) still observe the rejection
    // normally since this doesn't replace the stored promise.
    void session.loopPromise.catch(() => undefined);

    if (request.timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        void this.cancel(handle, 'timeout');
      }, request.timeoutMs);
      timer.unref?.();
      // Promise.finally() returns a new promise that preserves rejection. If
      // discarded, a routine transport failure becomes an unhandled rejection
      // and can crash the surrounding Trigger task before workflow retry logic
      // records the failure. Handle both branches explicitly so timer cleanup
      // always resolves.
      void session.loopPromise.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      );
    }

    return handle;
  }

  async reconcileStart(
    request: RuntimeStartRequest,
  ): Promise<RuntimeHandle | undefined> {
    const sessionId = deriveSessionId(
      this.#ownershipSecret,
      request.runId,
      request.stepId,
    );
    return this.#sessions.get(sessionId)?.handle;
  }

  async *events(handle: RuntimeHandle): AsyncIterable<RuntimeEvent> {
    const session = this.#sessions.get(handle.id);
    if (session === undefined) {
      yield Object.freeze({
        id: 'kimiEvent_unknown',
        type: 'error' as RuntimeEventType,
        occurredAt: new Date(this.#clock()),
        payload: { message: `unknown session: ${handle.id}` },
      });
      return;
    }
    let index = 0;
    for (;;) {
      while (index < session.events.length) {
        yield session.events[index]!;
        index += 1;
      }
      if (isTerminal(session.status)) return;
      await new Promise<void>((resolve) => session.waiters.push(resolve));
    }
  }

  async send(handle: RuntimeHandle, message: unknown): Promise<void> {
    const session = this.#sessions.get(handle.id);
    if (session === undefined || isTerminal(session.status)) return;
    // Task 1's runKimiAgentLoop does not yet expose a channel for injecting
    // additional user turns into an in-flight loop; queue for future
    // consumption so this is a well-defined no-op rather than silently
    // dropped, and so a later loop revision can start consuming it.
    session.pendingUserTurns.push(message);
  }

  async resume(handle: RuntimeHandle, input?: unknown): Promise<void> {
    if (input === undefined) return;
    await this.send(handle, input);
  }

  async cancel(handle: RuntimeHandle, reason?: string): Promise<void> {
    const session = this.#sessions.get(handle.id);
    if (session === undefined || isTerminal(session.status)) return;
    session.controller.abort();
    this.#terminate(session, 'cancelled', 'terminated', {
      reason: reason ?? 'cancelled',
    });
  }

  async collectOutput(handle: RuntimeHandle): Promise<RuntimeOutput> {
    const session = this.#requireSession(handle);
    if (session.status === 'running') {
      // Only wait on the loop when it's genuinely still running. Once the
      // session is terminal (e.g. cancelled), the underlying transport may
      // never settle (Task 1's transport doesn't honor the abort signal),
      // so awaiting loopPromise here would otherwise block forever.
      await session.loopPromise.catch(() => undefined);
    }
    if (session.status === 'failed' && session.failure !== undefined) {
      throw session.failure;
    }
    if (session.status !== 'submitted') {
      const detail =
        session.failure === undefined ? '' : `: ${errorMessage(session.failure)}`;
      throw new KimiRuntimeProviderError(
        `session did not submit a result (status: ${session.status}${detail})`,
      );
    }
    return toRuntimeOutput(session.result, session.putArtifacts);
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage> {
    const session = this.#requireSession(handle);
    const runtimeMs = Date.parse(this.#clock()) - session.startedAtMs;
    return {
      inputTokens: session.usage.inputTokens,
      outputTokens: session.usage.outputTokens,
      runtimeMs: Math.max(0, runtimeMs),
    };
  }

  async cleanup(handle: RuntimeHandle): Promise<void> {
    const session = this.#sessions.get(handle.id);
    if (session === undefined) return;
    if (!isTerminal(session.status)) {
      session.controller.abort();
      // Finalize and wake any parked events() consumers immediately: the
      // loop's own resolution may never observe the abort (Task 1's
      // transport doesn't honor the signal on an in-flight request), so
      // nothing else would ever mark this session terminal otherwise.
      this.#terminate(session, 'cancelled', 'terminated', {
        reason: 'cleanup',
      });
      // Do not await loop completion: for the same reason, a still-running
      // turn could block cleanup indefinitely. Swallow so an eventual
      // settlement never surfaces as an unhandled rejection (a handler is
      // also attached at loopPromise creation time; this is redundant but
      // harmless).
      void session.loopPromise.catch(() => undefined);
    }
    // Run destroy() under the same mutex as tool calls / observeCommand so
    // it can't race an in-flight bash/file operation still using workdir.
    await withMutex(session, () => session.sandbox.destroy());
    this.#sessions.delete(handle.id);
  }

  async cleanupAccess(input: {
    readonly resources: readonly RuntimeFileResource[];
    readonly credentialRefs: readonly string[];
  }): Promise<void> {
    this.#accessCleanup?.(input);
  }

  async observeCommand(
    handle: RuntimeHandle,
    expectedCommand: string,
  ): Promise<RuntimeObservedCommand> {
    const session = this.#requireSession(handle);
    return withMutex(session, async () => {
      const startedAt = this.#clock();
      // sandbox.runBash always constructs its own minimal, secretless
      // child-process env (PATH/HOME/LANG only) -- there is no channel for
      // the apiKey to reach it, satisfying the "never leak credentials to
      // observed commands" requirement without extra plumbing here.
      // Bound by the session's abort signal for the same reason the agent's
      // own bash calls are: cancel()/cleanup() must be able to reclaim the
      // mutex (and the workdir) without waiting out the command's timeout.
      const result = await session.sandbox.runBash(expectedCommand, {
        signal: session.controller.signal,
      });
      const completedAt = this.#clock();
      return Object.freeze({
        command: expectedCommand,
        exitCode: result.exitCode,
        startedAt,
        completedAt,
      });
    });
  }

  #requireSession(handle: RuntimeHandle): KimiSession {
    const session = this.#sessions.get(handle.id);
    if (session === undefined) {
      throw new KimiRuntimeProviderError(
        `unknown session: ${handle.id}`,
        'runtime_session_missing',
      );
    }
    return session;
  }

  /**
   * Transitions `session` to a terminal `status` and emits the terminal
   * event, unless the session is already terminal -- in which case this is
   * a no-op and returns false. Callers that only mutate session state on a
   * successful transition (e.g. stashing `result`) must check the return
   * value, so a late loop resolution can never resurrect or duplicate an
   * already-finalized (cancelled/cleaned-up/timed-out) session.
   */
  #terminate(
    session: KimiSession,
    status: KimiSessionStatus,
    type: RuntimeEventType,
    payload: unknown,
  ): boolean {
    if (isTerminal(session.status)) return false;
    session.status = status;
    this.#emit(session, type, payload);
    return true;
  }

  #emit(session: KimiSession, type: RuntimeEventType, payload: unknown): void {
    const event: RuntimeEvent = Object.freeze({
      id: `kimiEvent_${session.nextEventSeq}`,
      type,
      occurredAt: new Date(this.#clock()),
      payload,
    });
    session.nextEventSeq += 1;
    session.events.push(event);
    const waiters = session.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

// --- tool executor -------------------------------------------------

function withMutex<T>(session: KimiSession, fn: () => Promise<T>): Promise<T> {
  const run = session.mutex.then(fn, fn);
  session.mutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function buildExecutor(
  session: KimiSession,
  artifactMcp: ResolvedArtifactMcp | undefined,
): KimiToolExecutor {
  return {
    execute(name, input) {
      return withMutex(session, () =>
        runTool(session, artifactMcp, name, input),
      );
    },
  };
}

async function runTool(
  session: KimiSession,
  artifactMcp: ResolvedArtifactMcp | undefined,
  name: string,
  input: unknown,
): Promise<{ readonly content: string; readonly isError: boolean }> {
  try {
    switch (name) {
      case 'bash': {
        const parsed = bashInputSchema.parse(input);
        const result = await session.sandbox.runBash(parsed.command, {
          ...(parsed.timeoutMs === undefined
            ? {}
            : { timeoutMs: Math.min(parsed.timeoutMs, MAX_BASH_TIMEOUT_MS) }),
          signal: session.controller.signal,
        });
        return {
          content: JSON.stringify({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          }),
          isError: result.exitCode !== 0,
        };
      }
      case 'read': {
        const parsed = readInputSchema.parse(input);
        const content = await session.sandbox.readFile(parsed.path);
        return { content, isError: false };
      }
      case 'write': {
        const parsed = writeInputSchema.parse(input);
        await session.sandbox.writeFile(parsed.path, parsed.content);
        return { content: 'ok', isError: false };
      }
      case 'edit': {
        const parsed = editInputSchema.parse(input);
        await session.sandbox.editFile(
          parsed.path,
          parsed.oldText,
          parsed.newText,
        );
        return { content: 'ok', isError: false };
      }
      case 'artifact_put': {
        if (artifactMcp === undefined || session.credentialRef === undefined) {
          return {
            content: 'artifact tools are not configured',
            isError: true,
          };
        }
        const parsed = artifactPutInputSchema.parse(input);
        const bearer = await artifactMcp.resolveCredential(
          session.credentialRef,
        );
        const structured = await callArtifactMcp(
          artifactMcp,
          bearer,
          'artifact.put',
          parsed,
          session.controller.signal,
        );
        const metadata = extractPutMetadata(structured);
        session.putArtifacts.push({
          key: metadata.key,
          mediaType: metadata.mediaType,
          sizeBytes: metadata.sizeBytes,
          ...(metadata.digest === undefined ? {} : { hash: metadata.digest }),
        });
        // The same shape the Managed Agents MCP presents, because the agent
        // prompts are written once for both runtimes: they say to copy
        // `structuredContent.metadata` verbatim into the final message. This
        // used to answer with `{key, sizeBytes}`, so an agent on this runtime
        // could only invent the other eight fields, and every run died at
        // its first artifact reference.
        return {
          content: JSON.stringify({
            structuredContent: { metadata: metadata.record },
          }),
          isError: false,
        };
      }
      case 'artifact_get': {
        if (artifactMcp === undefined || session.credentialRef === undefined) {
          return {
            content: 'artifact tools are not configured',
            isError: true,
          };
        }
        const parsed = artifactGetInputSchema.parse(input);
        const bearer = await artifactMcp.resolveCredential(
          session.credentialRef,
        );
        const structured = await callArtifactMcp(
          artifactMcp,
          bearer,
          'artifact.get',
          parsed,
          session.controller.signal,
        );
        return { content: JSON.stringify(structured), isError: false };
      }
      default:
        return { content: `unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { content: errorMessage(error), isError: true };
  }
}

// Bounds every artifact MCP call so a stuck server can never hold the
// per-session mutex (and therefore cancel()/cleanup()) open indefinitely.
const ARTIFACT_MCP_TIMEOUT_MS = 60_000;

async function callArtifactMcp(
  artifactMcp: ResolvedArtifactMcp,
  bearer: string,
  method: 'artifact.put' | 'artifact.get',
  args: Record<string, unknown>,
  sessionSignal: AbortSignal,
): Promise<Record<string, unknown>> {
  // Tied to the session's own abort signal (cancel()/cleanup()/timeout)
  // *and* a fixed upper bound, so cancelling the session -- or a merely
  // slow/hung Artifact MCP server -- always releases the mutex promptly
  // instead of holding it open behind an unbounded fetch.
  const signal = AbortSignal.any([
    sessionSignal,
    AbortSignal.timeout(ARTIFACT_MCP_TIMEOUT_MS),
  ]);
  let response: Response;
  try {
    response = await artifactMcp.fetchImpl(artifactMcp.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bearer}`,
        'mcp-protocol-version': ARTIFACT_MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: { name: method, arguments: args },
      }),
      signal,
    });
  } catch (error) {
    // Normalize to a fixed, generic message regardless of what the
    // underlying fetch implementation's abort/timeout error happens to say
    // -- it must never be able to echo request details (the bearer is only
    // ever sent as a header, never part of this thrown message).
    if (signal.aborted) {
      throw new Error('artifact MCP request was aborted or timed out', {
        cause: error,
      });
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(
      `artifact MCP request failed with status ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    readonly result?: {
      readonly structuredContent?: Record<string, unknown>;
    };
    readonly error?: { readonly message?: string };
  };
  if (body.error !== undefined) {
    throw new Error(
      typeof body.error.message === 'string'
        ? body.error.message
        : 'artifact MCP error',
    );
  }
  const structured = body.result?.structuredContent;
  if (structured === undefined) {
    throw new Error('artifact MCP response is malformed');
  }
  return structured;
}

function extractPutMetadata(structured: Record<string, unknown>): {
  readonly key: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly digest: string | undefined;
  /**
   * The whole metadata object exactly as the Artifact MCP returned it. The
   * agent has to echo this into its final message, so narrowing it to the
   * fields this runtime happens to need leaves the model inventing the rest.
   */
  readonly record: Record<string, unknown>;
} {
  const metadata = structured.metadata;
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    typeof (metadata as Record<string, unknown>).key !== 'string' ||
    typeof (metadata as Record<string, unknown>).mediaType !== 'string' ||
    typeof (metadata as Record<string, unknown>).sizeBytes !== 'number'
  ) {
    throw new Error('artifact MCP put response is malformed');
  }
  const record = metadata as Record<string, unknown>;
  return {
    key: record.key as string,
    mediaType: record.mediaType as string,
    sizeBytes: record.sizeBytes as number,
    digest: typeof record.digest === 'string' ? record.digest : undefined,
    record,
  };
}

// --- helpers -------------------------------------------------

function deriveSessionId(
  ownershipSecret: string,
  runId: string,
  stepId: string,
): string {
  const hex = createHmac('sha256', ownershipSecret)
    .update(
      canonicalJsonValue({ version: 'kimi-session-id-v1', runId, stepId }),
    )
    .digest('hex');
  return `kimi_${hex.slice(0, 32)}`;
}

function toRuntimeOutput(
  result: unknown,
  artifacts: readonly RuntimeArtifactReference[],
): RuntimeOutput {
  if (typeof result === 'string') {
    return { text: result, artifacts };
  }
  return { data: result, artifacts };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function validateHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KimiRuntimeProviderError(`${label} must be a valid URL`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username !== '' ||
    url.password !== '' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  ) {
    throw new KimiRuntimeProviderError(
      `${label} must be an HTTP(S) URL without credentials (HTTP is localhost-only)`,
    );
  }
  return url.toString();
}

function validateOptions(
  options: KimiRuntimeProviderOptions,
): ValidatedOptions {
  if (
    typeof options.apiKey !== 'string' ||
    options.apiKey.trim().length === 0
  ) {
    throw new KimiRuntimeProviderError('apiKey is required');
  }
  if (
    typeof options.ownershipSecret !== 'string' ||
    options.ownershipSecret.length === 0
  ) {
    throw new KimiRuntimeProviderError('ownershipSecret is required');
  }
  if (Buffer.byteLength(options.ownershipSecret, 'utf8') < 32) {
    throw new KimiRuntimeProviderError(
      'ownershipSecret must be at least 32 bytes',
    );
  }
  if (
    typeof options.sandboxRoot !== 'string' ||
    options.sandboxRoot.trim().length === 0
  ) {
    throw new KimiRuntimeProviderError('sandboxRoot is required');
  }
  if (options.baseUrl !== undefined)
    validateHttpUrl(options.baseUrl, 'baseUrl');
  const artifactMcp: ResolvedArtifactMcp | undefined =
    options.artifactMcp === undefined
      ? undefined
      : {
          url: validateHttpUrl(options.artifactMcp.url, 'artifactMcp.url'),
          resolveCredential: options.artifactMcp.resolveCredential,
          fetchImpl: options.artifactMcp.fetchImpl ?? fetch,
        };
  const transport =
    options.transport ??
    createKimiHttpTransport({
      apiKey: options.apiKey,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
  return {
    transport,
    sandboxRoot: options.sandboxRoot,
    ownershipSecret: options.ownershipSecret,
    resolveFile: options.resolveFile,
    artifactMcp,
    accessCleanup: options.accessCleanup,
    clock: options.clock ?? (() => new Date().toISOString()),
  };
}
