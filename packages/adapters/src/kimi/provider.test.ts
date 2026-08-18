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

import {
  createKimiRuntimeProvider,
  KimiRuntimeProviderError,
} from './provider.js';
import type { KimiTransport } from './types.js';

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
                  key: 'proj/run-1/step-1/report/1',
                  mediaType: 'text/plain',
                  sizeBytes: 14,
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
      },
    ]);
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
});
