import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  RuntimeAgent,
  RuntimeEnvironment,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeStartRequest,
} from '@agentos/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiLocalAccessStore } from './access.js';
import {
  createKimiRuntimeProvider,
  KimiRuntimeProviderError,
} from './provider.js';
import type { KimiSandbox } from './sandbox.js';
import type { KimiTransport } from './types.js';

/**
 * Records every runBash invocation the provider makes (the agent's `bash`
 * tool and `observeCommand` alike) while still running the real sandbox, so
 * tests can assert on what is actually handed to the child process: the
 * clamped timeout and the session's abort signal.
 */
const { runBashCalls } = vi.hoisted(() => ({
  runBashCalls: [] as {
    command: string;
    options: { timeoutMs?: number; signal?: AbortSignal } | undefined;
    result: Promise<{ stdout: string; stderr: string; exitCode: number }>;
  }[],
}));

vi.mock('./sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandbox.js')>();
  return {
    ...actual,
    createKimiSandbox: async (
      options: Parameters<typeof actual.createKimiSandbox>[0],
    ): Promise<KimiSandbox> => {
      const sandbox = await actual.createKimiSandbox(options);
      return Object.freeze({
        ...sandbox,
        runBash: (
          command: string,
          runOptions?: { timeoutMs?: number; signal?: AbortSignal },
        ) => {
          const result = sandbox.runBash(command, runOptions);
          runBashCalls.push({ command, options: runOptions, result });
          return result;
        },
      });
    },
  };
});

const OWNERSHIP_SECRET = 'x'.repeat(32); // exactly 32 bytes, the minimum

const AGENT: RuntimeAgent = {
  id: 'agent-1',
  model: 'kimi-test',
  instructions: 'be a helpful sandboxed coding agent',
  tools: [],
  mcps: [],
};

const ENVIRONMENT: RuntimeEnvironment = {
  id: 'env-1',
  runtime: 'self_hosted',
  variables: {},
};

function baseRequest(
  overrides: Partial<RuntimeStartRequest> = {},
): RuntimeStartRequest {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    agentId: AGENT.id,
    environmentId: ENVIRONMENT.id,
    input: { task: 'do it' },
    ...overrides,
  };
}

const tempRoots: string[] = [];

async function newSandboxRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-provider-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  runBashCalls.splice(0);
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

type SendRequest = Parameters<KimiTransport['send']>[0];
type SendResponse = Awaited<ReturnType<KimiTransport['send']>>;

function scriptedTransport(responses: readonly SendResponse[]): {
  readonly transport: KimiTransport;
  readonly calls: SendRequest[];
} {
  const calls: SendRequest[] = [];
  let index = 0;
  return {
    calls,
    transport: {
      async send(request) {
        calls.push(request);
        const response = responses[index];
        index += 1;
        if (response === undefined) {
          throw new Error('scriptedTransport: no more scripted responses');
        }
        return response;
      },
    },
  };
}

/** A transport whose send() never settles; useful when a test only needs a
 * live session to exist and doesn't care about the agent loop's outcome. */
function neverRespondingTransport(): KimiTransport {
  return { send: () => new Promise<SendResponse>(() => {}) };
}

async function makeProvider(
  options: Partial<Parameters<typeof createKimiRuntimeProvider>[0]> & {
    readonly transport: KimiTransport;
  },
): Promise<{
  readonly provider: RuntimeProvider;
  readonly sandboxRoot: string;
}> {
  const sandboxRoot = options.sandboxRoot ?? (await newSandboxRoot());
  const provider = createKimiRuntimeProvider({
    apiKey: 'test-api-key',
    ownershipSecret: OWNERSHIP_SECRET,
    sandboxRoot,
    ...options,
  });
  await provider.syncAgent(AGENT);
  await provider.syncEnvironment(ENVIRONMENT);
  return { provider, sandboxRoot };
}

async function collectEvents(
  provider: RuntimeProvider,
  handle: RuntimeHandle,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of provider.events(handle)) {
    events.push(event);
  }
  return events;
}

describe('createKimiRuntimeProvider', () => {
  it('rejects a short ownershipSecret', () => {
    expect(() =>
      createKimiRuntimeProvider({
        apiKey: 'k',
        ownershipSecret: 'too-short',
        sandboxRoot: '/tmp/does-not-matter',
      }),
    ).toThrow(KimiRuntimeProviderError);
  });

  it('rejects an empty apiKey', () => {
    expect(() =>
      createKimiRuntimeProvider({
        apiKey: '',
        ownershipSecret: OWNERSHIP_SECRET,
        sandboxRoot: '/tmp/does-not-matter',
      }),
    ).toThrow(KimiRuntimeProviderError);
  });

  it('runs a write-then-submit session end to end: start -> events -> collectOutput', async () => {
    const { transport } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'write',
            input: { path: 'out.txt', content: 'hello from kimi' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_result',
            input: { summary: 'wrote the file', value: 42 },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 6, outputTokens: 2 },
      },
    ]);
    const { provider, sandboxRoot } = await makeProvider({ transport });

    const handle = await provider.start(baseRequest());
    const events = await collectEvents(provider, handle);

    expect(events.some((event) => event.type === 'tool_call')).toBe(true);
    expect(events.some((event) => event.type === 'tool_result')).toBe(true);
    expect(events.at(-1)?.type).toBe('terminated');

    const output = await provider.collectOutput(handle);
    expect(output).toEqual({
      data: { summary: 'wrote the file', value: 42 },
      artifacts: [],
    });

    const written = await fs.readFile(
      path.join(sandboxRoot, handle.id, 'out.txt'),
      'utf8',
    );
    expect(written).toBe('hello from kimi');
  });

  it('is idempotent on start and reconcileStart recognizes the same id, undefined for a foreign binding', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    const request = baseRequest();

    const first = await provider.start(request);
    const second = await provider.start(request);
    expect(second.id).toBe(first.id);

    const reconciled = await provider.reconcileStart!(request);
    expect(reconciled?.id).toBe(first.id);

    const foreign = await provider.reconcileStart!(
      baseRequest({
        runId: 'run-does-not-exist',
        stepId: 'step-does-not-exist',
      }),
    );
    expect(foreign).toBeUndefined();
  });

  it('rejects start for an unknown agentId', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    await expect(
      provider.start(baseRequest({ agentId: 'no-such-agent' })),
    ).rejects.toThrow(KimiRuntimeProviderError);
  });

  it('cancel mid-loop appends a terminal event and collectOutput throws', async () => {
    let callCount = 0;
    let resolveSecondCallStarted: () => void;
    const secondCallStarted = new Promise<void>((resolve) => {
      resolveSecondCallStarted = resolve;
    });
    let resolveSecondResponse: (value: SendResponse) => void;
    const secondResponse = new Promise<SendResponse>((resolve) => {
      resolveSecondResponse = resolve;
    });
    const transport: KimiTransport = {
      async send() {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'bash',
                input: { command: 'true' },
              },
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        resolveSecondCallStarted();
        return secondResponse;
      },
    };
    const { provider } = await makeProvider({ transport });

    const handle = await provider.start(baseRequest());
    await secondCallStarted;
    await provider.cancel(handle, 'test cancel reason');

    const events = await collectEvents(provider, handle);
    expect(
      events.some(
        (event) =>
          event.type === 'terminated' &&
          (event.payload as { reason?: string } | undefined)?.reason ===
            'test cancel reason',
      ),
    ).toBe(true);

    // Let the in-flight turn resolve so the loop can settle (the mock
    // transport doesn't honor the abort signal, matching Task 1's real HTTP
    // transport, which never passes the signal to fetch either).
    resolveSecondResponse!({
      content: [
        {
          type: 'tool_use',
          id: 'call_2',
          name: 'bash',
          input: { command: 'true' },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await expect(provider.collectOutput(handle)).rejects.toThrow(
      KimiRuntimeProviderError,
    );
  });

  it('a submit_result arriving after cancel does not resurrect the session', async () => {
    let callCount = 0;
    let resolveSecondCallStarted: () => void;
    const secondCallStarted = new Promise<void>((resolve) => {
      resolveSecondCallStarted = resolve;
    });
    let resolveSecondResponse: (value: SendResponse) => void;
    const secondResponse = new Promise<SendResponse>((resolve) => {
      resolveSecondResponse = resolve;
    });
    const transport: KimiTransport = {
      async send() {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'bash',
                input: { command: 'true' },
              },
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        resolveSecondCallStarted();
        return secondResponse;
      },
    };
    const { provider } = await makeProvider({ transport });

    const handle = await provider.start(baseRequest());
    await secondCallStarted;
    await provider.cancel(handle, 'pre-empt');

    // The in-flight turn resolves with a submit_result -- loop.ts returns
    // status:'submitted' without ever re-checking the abort signal. The
    // provider must not let this resurrect an already-cancelled session.
    resolveSecondResponse!({
      content: [
        {
          type: 'tool_use',
          id: 'call_2',
          name: 'submit_result',
          input: { sneaky: true },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const events = await collectEvents(provider, handle);
    const terminalEvents = events.filter(
      (event) => event.type === 'terminated' || event.type === 'error',
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe('terminated');
    expect(
      (terminalEvents[0]?.payload as { reason?: string } | undefined)?.reason,
    ).toBe('pre-empt');

    await expect(provider.collectOutput(handle)).rejects.toThrow(
      KimiRuntimeProviderError,
    );
  });

  it('cancel with a never-resolving in-flight transport still lets collectOutput reject promptly', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    const handle = await provider.start(baseRequest());
    await provider.cancel(handle, 'stuck');

    // Must resolve without ever awaiting the (permanently pending) loop
    // promise -- collectOutput fails fast once status is already terminal.
    await expect(provider.collectOutput(handle)).rejects.toThrow(
      KimiRuntimeProviderError,
    );
  });

  it('a rejecting transport with a session timeout fails without an unhandled rejection', async () => {
    const transport: KimiTransport = {
      async send() {
        throw new Error('transport exploded');
      },
    };
    const { provider } = await makeProvider({ transport });
    // Supplying timeoutMs installs the timer-cleanup handler. That cleanup
    // must not create a second, unobserved rejected promise when the loop
    // itself rejects.
    const handle = await provider.start(baseRequest({ timeoutMs: 1_000 }));

    const events = await collectEvents(provider, handle);
    expect(
      events.some(
        (event) =>
          event.type === 'error' &&
          (event.payload as { message?: string } | undefined)?.message ===
            'transport exploded',
      ),
    ).toBe(true);

    await expect(provider.collectOutput(handle)).rejects.toThrow(
      KimiRuntimeProviderError,
    );
  });

  it('turn_limit resolution emits an error event and collectOutput rejects', async () => {
    const transport: KimiTransport = {
      async send() {
        return {
          content: [{ type: 'text', text: 'still thinking...' }],
          stopReason: null,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const { provider } = await makeProvider({ transport });
    const handle = await provider.start(baseRequest());

    const events = await collectEvents(provider, handle);
    expect(
      events.some(
        (event) =>
          event.type === 'error' &&
          (event.payload as { reason?: string } | undefined)?.reason ===
            'turn_limit',
      ),
    ).toBe(true);

    await expect(provider.collectOutput(handle)).rejects.toThrow(
      KimiRuntimeProviderError,
    );
  }, 10_000);

  it('enforces request.timeoutMs by cancelling the session after the deadline', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    const handle = await provider.start(baseRequest({ timeoutMs: 20 }));

    const events = await collectEvents(provider, handle);
    expect(
      events.some(
        (event) =>
          event.type === 'terminated' &&
          (event.payload as { reason?: string } | undefined)?.reason ===
            'timeout',
      ),
    ).toBe(true);

    await expect(provider.collectOutput(handle)).rejects.toThrow(
      KimiRuntimeProviderError,
    );
  }, 10_000);

  it('rejects a non-positive request.timeoutMs (fail closed)', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    await expect(provider.start(baseRequest({ timeoutMs: 0 }))).rejects.toThrow(
      KimiRuntimeProviderError,
    );
  });

  it('fails closed for unknown handles across events/usage/collectOutput/observeCommand', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    const bogus: RuntimeHandle = Object.freeze({ id: 'kimi_does_not_exist' });

    const events = await collectEvents(provider, bogus);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');

    await expect(provider.usage(bogus)).rejects.toMatchObject({
      name: 'KimiRuntimeProviderError',
      code: 'runtime_session_missing',
    });
    await expect(provider.collectOutput(bogus)).rejects.toThrow(
      KimiRuntimeProviderError,
    );
    await expect(provider.observeCommand!(bogus, 'true')).rejects.toThrow(
      KimiRuntimeProviderError,
    );
  });

  it('cleanup on a running session terminates any parked events() consumer', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    const handle = await provider.start(baseRequest());

    const eventsPromise = collectEvents(provider, handle);
    // Give the events() generator a turn to park on its waiter before we
    // clean up -- otherwise this wouldn't exercise the "wake a parked
    // consumer" path at all.
    await new Promise((resolve) => setImmediate(resolve));

    await provider.cleanup(handle);

    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe('terminated');
    expect(
      (events.at(-1)?.payload as { reason?: string } | undefined)?.reason,
    ).toBe('cleanup');
  });

  it('serializes observeCommand behind an in-flight slow bash tool call (mutex)', async () => {
    const { transport } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'bash',
            input: { command: 'sleep 0.2 && echo bash >> order.log' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_result',
            input: { ok: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const { provider, sandboxRoot } = await makeProvider({ transport });
    const handle = await provider.start(baseRequest());

    // Wait until the loop has issued the tool_call event for the slow bash
    // command -- at that point it has synchronously queued onto the session
    // mutex (queuing is synchronous; only execution of the sleep is async),
    // so racing observeCommand against it here is deterministic, not a
    // best-effort timing hope.
    for await (const event of provider.events(handle)) {
      if (event.type === 'tool_call') break;
    }

    await provider.observeCommand!(handle, 'echo observe >> order.log');

    const log = await fs.readFile(
      path.join(sandboxRoot, handle.id, 'order.log'),
      'utf8',
    );
    expect(log).toBe('bash\nobserve\n');
  }, 10_000);

  it('accumulates usage across turns', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => new Date(now).toISOString();
    const { transport } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'bash',
            input: { command: 'true' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_result',
            input: { ok: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 6, outputTokens: 2 },
      },
    ]);
    const { provider } = await makeProvider({ transport, clock });

    const handle = await provider.start(baseRequest());
    await collectEvents(provider, handle);
    now += 5_000;
    const usage = await provider.usage(handle);

    expect(usage.inputTokens).toBe(16);
    expect(usage.outputTokens).toBe(7);
    expect(usage.runtimeMs).toBe(5_000);
  });

  it('observeCommand returns exit 0 for true and nonzero for false', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    const handle = await provider.start(baseRequest());

    const ok = await provider.observeCommand!(handle, 'true');
    expect(ok.command).toBe('true');
    expect(ok.exitCode).toBe(0);
    expect(Date.parse(ok.startedAt)).not.toBeNaN();
    expect(Date.parse(ok.completedAt)).not.toBeNaN();

    const failed = await provider.observeCommand!(handle, 'false');
    expect(failed.exitCode).not.toBe(0);
  });

  it('observeCommand runs with a secretless env: a set env var never reaches the child', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    const handle = await provider.start(baseRequest());

    process.env.KIMI_TEST_SECRET = 'super-secret-value';
    try {
      // RuntimeObservedCommand (ports.ts) carries no stdout/stderr field --
      // only command/exitCode/startedAt/completedAt -- so "empty observed
      // output" is expressed as an exit-code truth test rather than
      // capturing text: exit 0 here proves KIMI_TEST_SECRET was unset in
      // the child, since it is set in this test process's own env.
      const observed = await provider.observeCommand!(
        handle,
        'test -z "${KIMI_TEST_SECRET:-}"',
      );
      expect(observed.exitCode).toBe(0);
    } finally {
      delete process.env.KIMI_TEST_SECRET;
    }
  });

  it('hands the agent the whole artifact reference, not the two fields this runtime uses', async () => {
    // Agents must echo `structuredContent.metadata` into their final message,
    // and the prompts saying so are shared with the managed runtime. This
    // used to answer with {key, sizeBytes}, so an agent here could only
    // invent projectId, runId, stepId, artifactId, version, digest,
    // mediaType and retentionClass -- and every run died on its first
    // artifact reference, looking exactly like the model disobeying.
    const metadata = {
      projectId: 'proj',
      runId: 'run-1',
      stepId: 'step-1',
      artifactId: 'report',
      version: 1,
      key: 'proj/run-1/step-1/report/1',
      digest: 'd'.repeat(64),
      mediaType: 'text/plain',
      sizeBytes: 14,
      retentionClass: 'working',
      createdAt: '2026-08-24T12:00:00.000Z',
      expiresAt: '2026-08-31T12:00:00.000Z',
    };
    const { transport } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'artifact_put',
            input: {
              artifactId: 'report',
              version: 1,
              mediaType: 'text/plain',
              contentBase64: Buffer.from('hello artifact').toString('base64'),
            },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_result',
            input: { done: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { readonly id: string };
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { metadata },
            isError: false,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const { provider } = await makeProvider({
      transport,
      artifactMcp: {
        url: 'https://control.agentos.test/api/mcp/artifacts',
        resolveCredential: async (ref: string) => `bearer-for-${ref}`,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    const handle = await provider.start(
      baseRequest({ credentialRefs: ['vault_abc123'] }),
    );
    const events = await collectEvents(provider, handle);

    const result = events.find(
      (event) =>
        event.type === 'tool_result' &&
        JSON.stringify(event).includes('structuredContent'),
    );
    expect(result).toBeDefined();
    // The provider wraps each loop event as `payload: { detail }`, where the
    // detail is the JSON the loop recorded for the tool result.
    const { detail } = result?.payload as { readonly detail: string };
    const { content } = JSON.parse(detail) as { readonly content: string };
    const echoed = JSON.parse(content) as {
      readonly structuredContent: { readonly metadata: unknown };
    };
    // Every field the agent has to echo, exactly as the MCP returned it.
    expect(echoed.structuredContent.metadata).toEqual(metadata);
  });

  it('artifact_put/artifact_get round-trip through a stubbed fetchImpl, sending the resolved bearer as Authorization and never echoing it', async () => {
    const { transport } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'artifact_put',
            input: {
              artifactId: 'report',
              version: 1,
              mediaType: 'text/plain',
              contentBase64: Buffer.from('hello artifact').toString('base64'),
            },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'artifact_get',
            input: { key: 'proj/run-1/step-1/report/1' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_3',
            name: 'submit_result',
            input: { done: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const resolveCredential = vi.fn(async (ref: string) => `bearer-for-${ref}`);
    const seenAuthorizationHeaders: string[] = [];
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seenAuthorizationHeaders.push(headers.get('authorization') ?? '');
        const body = JSON.parse(String(init?.body)) as {
          readonly id: string;
          readonly params: { readonly name: string };
        };
        const result =
          body.params.name === 'artifact.put'
            ? {
                metadata: {
                  projectId: 'proj',
                  runId: 'run-1',
                  stepId: 'step-1',
                  artifactId: 'report',
                  version: 1,
                  key: 'proj/run-1/step-1/report/1',
                  digest: 'd'.repeat(64),
                  mediaType: 'text/plain',
                  sizeBytes: 14,
                  retentionClass: 'working',
                  createdAt: '2026-08-24T12:00:00.000Z',
                  expiresAt: '2026-08-31T12:00:00.000Z',
                },
              }
            : {
                found: true,
                metadata: { key: 'proj/run-1/step-1/report/1' },
                contentBase64: Buffer.from('hello artifact').toString('base64'),
              };
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: 'ok' }],
              structuredContent: result,
              isError: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );

    const { provider } = await makeProvider({
      transport,
      artifactMcp: {
        url: 'https://control.agentos.test/api/mcp/artifacts',
        resolveCredential,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });

    const handle = await provider.start(
      baseRequest({ credentialRefs: ['vault_abc123'] }),
    );
    const events = await collectEvents(provider, handle);

    expect(resolveCredential).toHaveBeenCalledWith('vault_abc123');
    expect(seenAuthorizationHeaders).toEqual([
      'Bearer bearer-for-vault_abc123',
      'Bearer bearer-for-vault_abc123',
    ]);

    const toolResults = events.filter((event) => event.type === 'tool_result');
    const serialized = JSON.stringify(
      toolResults.map((event) => event.payload),
    );
    expect(serialized).not.toContain('bearer-for-vault_abc123');

    const output = await provider.collectOutput(handle);
    expect(output.data).toEqual({ done: true });
    expect(output.artifacts).toEqual([
      {
        key: 'proj/run-1/step-1/report/1',
        mediaType: 'text/plain',
        sizeBytes: 14,
        hash: 'd'.repeat(64),
      },
    ]);
  });

  it('cleanup completes promptly even when an artifact tool call is stuck behind a hung fetchImpl', async () => {
    const { transport } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'artifact_put',
            input: {
              artifactId: 'report',
              version: 1,
              mediaType: 'text/plain',
              contentBase64: Buffer.from('x').toString('base64'),
            },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const resolveCredential = vi.fn(async () => 'bearer-token');
    // Mimics real fetch()'s AbortSignal contract: never settles on its own,
    // but rejects once the signal it was given aborts. This is the
    // scenario a stuck Artifact MCP server produces.
    const fetchImpl = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new Error('simulated abort'));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(new Error('simulated abort'));
          });
        }),
    );

    const { provider } = await makeProvider({
      transport,
      artifactMcp: {
        url: 'https://control.agentos.test/api/mcp/artifacts',
        resolveCredential,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });

    const handle = await provider.start(
      baseRequest({ credentialRefs: ['vault_abc123'] }),
    );

    // Wait until the loop has issued the tool_call for artifact_put -- at
    // that point it has synchronously queued onto the session mutex and is
    // about to call the (permanently hanging, absent an abort) fetchImpl.
    for await (const event of provider.events(handle)) {
      if (event.type === 'tool_call') break;
    }

    const cleanupStarted = Date.now();
    await provider.cleanup(handle);
    expect(Date.now() - cleanupStarted).toBeLessThan(5_000);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('throws for credentialRefs without artifactMcp configuration (fail closed)', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    await expect(
      provider.start(baseRequest({ credentialRefs: ['vault_abc123'] })),
    ).rejects.toThrow(KimiRuntimeProviderError);
  });

  it('throws for resources without a resolveFile resolver (fail closed)', async () => {
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    await expect(
      provider.start(
        baseRequest({ resources: [{ type: 'file', fileId: 'file-1' }] }),
      ),
    ).rejects.toThrow(KimiRuntimeProviderError);
  });

  it('cleanup removes the sandbox workdir and unregisters the session', async () => {
    const { provider, sandboxRoot } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    const handle = await provider.start(baseRequest());
    const workdir = path.join(sandboxRoot, handle.id);
    await expect(fs.stat(workdir)).resolves.toBeDefined();

    await provider.cleanup(handle);

    await expect(fs.stat(workdir)).rejects.toThrow();
    const reconciled = await provider.reconcileStart!(baseRequest());
    expect(reconciled).toBeUndefined();
  });

  it('materializes a staged managed-shaped absolute mount into the workdir at the mapped path', async () => {
    // The realistic seam: production staging hands over the same
    // container-absolute mount paths the managed uploader takes.
    const store = createKimiLocalAccessStore();
    const body = '{"version":"source-bundle-v1"}';
    const staged = store.stage({
      files: [
        {
          bytes: new TextEncoder().encode(body),
          mountPath: '/workspace/inputs/source-bundle.json',
        },
      ],
      credentials: [],
    });
    const { provider, sandboxRoot } = await makeProvider({
      transport: neverRespondingTransport(),
      resolveFile: store.resolveFile,
    });

    const handle = await provider.start(
      baseRequest({ resources: staged.resources }),
    );

    await expect(
      fs.readFile(
        path.join(sandboxRoot, handle.id, 'inputs', 'source-bundle.json'),
        'utf8',
      ),
    ).resolves.toBe(body);
  });

  it('destroys the workdir when materialization fails, leaving nothing behind', async () => {
    const { provider, sandboxRoot } = await makeProvider({
      transport: neverRespondingTransport(),
      resolveFile: async () => new TextEncoder().encode('{}'),
    });

    await expect(
      provider.start(
        baseRequest({
          resources: [
            {
              type: 'file',
              fileId: 'kimi-file-abc',
              // Unnormalized: the sandbox rejects absolute paths.
              mountPath: '/workspace/inputs/source-bundle.json',
            },
          ],
        }),
      ),
    ).rejects.toThrow(/absolute paths are not allowed/);

    await expect(fs.readdir(sandboxRoot)).resolves.toEqual([]);
  });

  it('clamps an agent-supplied bash timeout to the 120s ceiling and binds the child to the session signal', async () => {
    const { transport } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'bash',
            input: { command: 'true', timeoutMs: 86_400_000 },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_result',
            input: { ok: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const { provider } = await makeProvider({ transport });

    const handle = await provider.start(baseRequest());
    await collectEvents(provider, handle);

    expect(runBashCalls).toHaveLength(1);
    expect(runBashCalls[0]?.options?.timeoutMs).toBe(120_000);
    expect(runBashCalls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('advertises the bash timeout ceiling in the tool schema it sends to the model', async () => {
    const { transport, calls } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'submit_result',
            input: { ok: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const { provider } = await makeProvider({ transport });

    const handle = await provider.start(baseRequest());
    await collectEvents(provider, handle);

    const bashTool = calls[0]?.tools.find((tool) => tool.name === 'bash');
    expect(
      (
        bashTool?.input_schema as {
          properties: { timeoutMs: { maximum: number } };
        }
      ).properties.timeoutMs.maximum,
    ).toBe(120_000);
  });

  it('cancel kills an in-flight bash child instead of waiting out its timeout', async () => {
    const { transport } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'bash',
            input: { command: 'sleep 30' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const { provider } = await makeProvider({ transport });

    const handle = await provider.start(baseRequest());
    await vi.waitFor(() => expect(runBashCalls).toHaveLength(1));

    await provider.cancel(handle, 'stop');

    // Resolves promptly (the test would otherwise time out on `sleep 30`).
    const result = await runBashCalls[0]!.result;
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  it('reports the tokens a cancelled session actually spent', async () => {
    let resolveSecondTurn: (() => void) | undefined;
    let sends = 0;
    const transport: KimiTransport = {
      async send() {
        sends += 1;
        if (sends === 1) {
          return {
            content: [
              {
                type: 'tool_use' as const,
                id: 'call_1',
                name: 'bash',
                input: { command: 'true' },
              },
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        // Second turn never settles: the session is still running when the
        // cancel arrives, which is exactly when usage() used to read zero.
        await new Promise<void>((resolve) => {
          resolveSecondTurn = resolve;
        });
        throw new Error('unreachable');
      },
    };
    const { provider } = await makeProvider({ transport });

    const handle = await provider.start(baseRequest());
    await vi.waitFor(() => expect(sends).toBe(2));
    await provider.cancel(handle, 'stop');

    const usage = await provider.usage(handle);
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
    resolveSecondTurn?.();
  });

  it('cleanupAccess forwards resources/credentialRefs to the accessCleanup hook and is a no-op without one', async () => {
    const accessCleanup = vi.fn();
    const { provider } = await makeProvider({
      transport: neverRespondingTransport(),
      accessCleanup,
    });
    const input = {
      resources: [
        { type: 'file' as const, fileId: 'kimi-file-abc', mountPath: '/x' },
      ],
      credentialRefs: ['kimi-cred-abc'],
    };
    await provider.cleanupAccess!(input);
    expect(accessCleanup).toHaveBeenCalledTimes(1);
    expect(accessCleanup).toHaveBeenCalledWith(input);

    const { provider: withoutHook } = await makeProvider({
      transport: neverRespondingTransport(),
    });
    await expect(withoutHook.cleanupAccess!(input)).resolves.toBeUndefined();
  });
});
