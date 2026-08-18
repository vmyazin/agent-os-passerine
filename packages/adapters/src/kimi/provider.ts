import { createHmac, randomUUID } from 'node:crypto';

import {
  canonicalJsonValue,
  type RuntimeAgent,
  type RuntimeArtifactReference,
  type RuntimeEnvironment,
  type RuntimeEvent,
  type RuntimeEventType,
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
  readonly clock?: () => string;
}

export function createKimiRuntimeProvider(
  options: KimiRuntimeProviderOptions,
): RuntimeProvider {
  return new KimiRuntimeProviderImpl(validateOptions(options));
}

// --- tool definitions -------------------------------------------------

const BASH_TOOL: KimiToolDefinition = {
  name: 'bash',
  description: 'Run a bash command in the sandbox working directory.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1 },
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
      const materialized = await Promise.all(
        resources.map(async (resource) => ({
          path: resource.mountPath ?? resource.fileId,
          content: await resolveFile(resource.fileId),
        })),
      );
      await sandbox.materialize(materialized);
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
    }).then(
      (result) => {
        session.usage = {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        };
        if (result.status === 'submitted') {
          session.status = 'submitted';
          session.result = result.result;
          this.#emit(session, 'terminated', { reason: 'submitted' });
        } else if (result.status === 'turn_limit') {
          session.status = 'turn_limit';
          this.#emit(session, 'error', { reason: 'turn_limit' });
        } else {
          // Cancellation already emitted its terminal event in cancel().
          session.status = 'cancelled';
        }
        return result;
      },
      (error: unknown) => {
        session.status = 'failed';
        this.#emit(session, 'error', { message: errorMessage(error) });
        throw error;
      },
    );

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
    session.status = 'cancelled';
    this.#emit(session, 'terminated', { reason: reason ?? 'cancelled' });
  }

  async collectOutput(handle: RuntimeHandle): Promise<RuntimeOutput> {
    const session = this.#requireSession(handle);
    const result = await session.loopPromise;
    if (result.status !== 'submitted') {
      throw new KimiRuntimeProviderError(
        `session did not submit a result (status: ${result.status})`,
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
      // Do not await loop completion: Task 1's transport does not honor the
      // abort signal on an in-flight request (createKimiHttpTransport never
      // passes it to fetch), so a still-running turn could otherwise block
      // cleanup indefinitely. Swallow so an eventual settlement never
      // surfaces as an unhandled rejection.
      void session.loopPromise.catch(() => undefined);
    }
    await session.sandbox.destroy();
    this.#sessions.delete(handle.id);
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
      const result = await session.sandbox.runBash(expectedCommand);
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
      throw new KimiRuntimeProviderError(`unknown session: ${handle.id}`);
    }
    return session;
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
        const result = await session.sandbox.runBash(
          parsed.command,
          parsed.timeoutMs === undefined
            ? undefined
            : { timeoutMs: parsed.timeoutMs },
        );
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
        );
        const metadata = extractPutMetadata(structured);
        session.putArtifacts.push({
          key: metadata.key,
          mediaType: metadata.mediaType,
          sizeBytes: metadata.sizeBytes,
          ...(metadata.digest === undefined ? {} : { hash: metadata.digest }),
        });
        return {
          content: JSON.stringify({
            key: metadata.key,
            sizeBytes: metadata.sizeBytes,
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

async function callArtifactMcp(
  artifactMcp: ResolvedArtifactMcp,
  bearer: string,
  method: 'artifact.put' | 'artifact.get',
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await artifactMcp.fetchImpl(artifactMcp.url, {
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
  });
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
    clock: options.clock ?? (() => new Date().toISOString()),
  };
}
