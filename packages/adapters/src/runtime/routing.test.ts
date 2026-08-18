import type {
  RuntimeAgent,
  RuntimeEnvironment,
  RuntimeEvent,
  RuntimeFileResource,
  RuntimeHandle,
  RuntimeObservedCommand,
  RuntimeOutput,
  RuntimeProvider,
  RuntimeStartRequest,
  RuntimeUsage,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import {
  createRoutingRuntimeProvider,
  RoutingRuntimeProviderError,
} from './routing.js';

type Call = { readonly method: string; readonly args: readonly unknown[] };

interface StubProvider extends RuntimeProvider {
  readonly calls: Call[];
}

function createStubProvider(options?: {
  readonly withObserveCommand?: boolean;
  readonly withCleanupAccess?: boolean;
  readonly withReconcileStart?: boolean;
  readonly startHandleId?: string;
}): StubProvider {
  const calls: Call[] = [];
  const record = (method: string, ...args: unknown[]) =>
    calls.push({ method, args });

  const provider: StubProvider = {
    calls,
    async syncAgent(agent: RuntimeAgent): Promise<void> {
      record('syncAgent', agent);
    },
    async syncEnvironment(environment: RuntimeEnvironment): Promise<void> {
      record('syncEnvironment', environment);
    },
    async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
      record('start', request);
      return { id: options?.startHandleId ?? 'session-1' };
    },
    events(handle: RuntimeHandle): AsyncIterable<RuntimeEvent> {
      record('events', handle);
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'evt-1',
            type: 'message',
            occurredAt: new Date(0),
          } satisfies RuntimeEvent;
        },
      };
    },
    async send(handle: RuntimeHandle, message: unknown): Promise<void> {
      record('send', handle, message);
    },
    async resume(handle: RuntimeHandle, input?: unknown): Promise<void> {
      record('resume', handle, input);
    },
    async cancel(handle: RuntimeHandle, reason?: string): Promise<void> {
      record('cancel', handle, reason);
    },
    async collectOutput(handle: RuntimeHandle): Promise<RuntimeOutput> {
      record('collectOutput', handle);
      return { artifacts: [] };
    },
    async usage(handle: RuntimeHandle): Promise<RuntimeUsage> {
      record('usage', handle);
      return { inputTokens: 1, outputTokens: 1, runtimeMs: 1 };
    },
    async cleanup(handle: RuntimeHandle): Promise<void> {
      record('cleanup', handle);
    },
  };

  if (options?.withCleanupAccess) {
    (
      provider as { cleanupAccess?: RuntimeProvider['cleanupAccess'] }
    ).cleanupAccess = async (input: {
      readonly resources: readonly RuntimeFileResource[];
      readonly credentialRefs: readonly string[];
    }): Promise<void> => {
      record('cleanupAccess', input);
    };
  }

  if (options?.withObserveCommand) {
    (
      provider as { observeCommand?: RuntimeProvider['observeCommand'] }
    ).observeCommand = async (
      handle: RuntimeHandle,
      expectedCommand: string,
    ): Promise<RuntimeObservedCommand> => {
      record('observeCommand', handle, expectedCommand);
      return {
        command: expectedCommand,
        exitCode: 0,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:01Z',
      };
    };
  }

  if (options?.withReconcileStart) {
    (
      provider as { reconcileStart?: RuntimeProvider['reconcileStart'] }
    ).reconcileStart = async (
      request: RuntimeStartRequest,
    ): Promise<RuntimeHandle | undefined> => {
      record('reconcileStart', request);
      return { id: options?.startHandleId ?? 'session-1' };
    };
  }

  return provider;
}

const AGENT_A: RuntimeAgent = {
  id: 'agent-a',
  model: 'model-a',
  tools: [],
  mcps: [],
};

const AGENT_DEFAULT: RuntimeAgent = {
  id: 'agent-default',
  model: 'model-default',
  tools: [],
  mcps: [],
};

const ENVIRONMENT: RuntimeEnvironment = {
  id: 'env-1',
  runtime: 'self_hosted',
  variables: {},
};

function baseRequest(agentId: string): RuntimeStartRequest {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    agentId,
    environmentId: ENVIRONMENT.id,
    input: { task: 'do it' },
  };
}

describe('createRoutingRuntimeProvider', () => {
  it('routes syncAgent/start/events/cancel to the provider selected by route()', async () => {
    const kimi = createStubProvider();
    const managed = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { kimi, managed },
      defaultProvider: 'managed',
      route: (agent) => (agent.id === AGENT_A.id ? 'kimi' : undefined),
    });

    await routing.syncAgent(AGENT_A);
    const handle = await routing.start(baseRequest(AGENT_A.id));
    await routing.cancel(handle, 'done');

    expect(kimi.calls.map((c) => c.method)).toEqual([
      'syncAgent',
      'start',
      'cancel',
    ]);
    expect(managed.calls).toEqual([]);
    // The provider receives the unwrapped inner handle.
    expect(kimi.calls[2]?.args[0]).toEqual({ id: 'session-1' });
  });

  it('falls back to defaultProvider when route() returns undefined', async () => {
    const kimi = createStubProvider();
    const managed = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { kimi, managed },
      defaultProvider: 'managed',
      route: () => undefined,
    });

    await routing.syncAgent(AGENT_DEFAULT);
    await routing.start(baseRequest(AGENT_DEFAULT.id));

    expect(managed.calls.map((c) => c.method)).toEqual(['syncAgent', 'start']);
    expect(kimi.calls).toEqual([]);
  });

  it('throws when route() returns an id not present in providers, never falling back', async () => {
    const kimi = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { kimi },
      defaultProvider: 'kimi',
      route: () => 'nonexistent',
    });

    await expect(routing.syncAgent(AGENT_A)).rejects.toThrow(
      RoutingRuntimeProviderError,
    );
    expect(kimi.calls).toEqual([]);
  });

  it('throws on a handle with an unknown runtime prefix', async () => {
    const kimi = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { kimi },
      defaultProvider: 'kimi',
      route: () => undefined,
    });

    await expect(
      routing.cancel({ id: 'unknown-provider session-1' }),
    ).rejects.toThrow(RoutingRuntimeProviderError);
  });

  it('throws on a start request for an agent that was never synced', async () => {
    const kimi = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { kimi },
      defaultProvider: 'kimi',
      route: () => undefined,
    });

    await expect(routing.start(baseRequest('never-synced'))).rejects.toThrow(
      RoutingRuntimeProviderError,
    );
  });

  it('fans syncEnvironment out to all providers', async () => {
    const kimi = createStubProvider();
    const managed = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { kimi, managed },
      defaultProvider: 'managed',
      route: () => undefined,
    });

    await routing.syncEnvironment(ENVIRONMENT);

    expect(kimi.calls.map((c) => c.method)).toEqual(['syncEnvironment']);
    expect(managed.calls.map((c) => c.method)).toEqual(['syncEnvironment']);
  });

  it('routes cleanupAccess only to the owning provider, skipping providers that do not define it', async () => {
    const managed = createStubProvider({ withCleanupAccess: true });
    const withoutAccess = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { managed, withoutAccess },
      defaultProvider: 'managed',
      route: () => undefined,
    });

    await routing.cleanupAccess?.({
      resources: [{ type: 'file', fileId: 'file_managed_1' }],
      credentialRefs: ['vault_managed_1'],
    });

    expect(managed.calls.map((c) => c.method)).toEqual(['cleanupAccess']);
    expect(withoutAccess.calls).toEqual([]);
  });

  it('partitions cleanupAccess between kimi-local ids and the default provider', async () => {
    const kimi = createStubProvider({ withCleanupAccess: true });
    const managed = createStubProvider({ withCleanupAccess: true });
    const routing = createRoutingRuntimeProvider({
      providers: { kimi, managed },
      defaultProvider: 'managed',
      route: () => undefined,
    });

    await routing.cleanupAccess?.({
      resources: [
        { type: 'file', fileId: 'kimi-file-aaa' },
        { type: 'file', fileId: 'file_managed_1' },
      ],
      credentialRefs: ['kimi-cred-bbb', 'vault_managed_1'],
    });

    expect(kimi.calls).toHaveLength(1);
    expect(kimi.calls[0]?.args[0]).toEqual({
      resources: [{ type: 'file', fileId: 'kimi-file-aaa' }],
      credentialRefs: ['kimi-cred-bbb'],
    });
    expect(managed.calls).toHaveLength(1);
    expect(managed.calls[0]?.args[0]).toEqual({
      resources: [{ type: 'file', fileId: 'file_managed_1' }],
      credentialRefs: ['vault_managed_1'],
    });
  });

  it('forwards observeCommand only when the target provider defines it, throwing otherwise', async () => {
    const withObserve = createStubProvider({ withObserveCommand: true });
    const withoutObserve = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { withObserve, withoutObserve },
      defaultProvider: 'withObserve',
      route: (agent) => agent.id,
    });

    await routing.syncAgent({ ...AGENT_A, id: 'withObserve' });
    const observedHandle = await routing.start(baseRequest('withObserve'));
    const observed = await routing.observeCommand?.(observedHandle, 'ls');
    expect(observed?.command).toBe('ls');
    expect(withObserve.calls.map((c) => c.method)).toEqual([
      'syncAgent',
      'start',
      'observeCommand',
    ]);

    await routing.syncAgent({ ...AGENT_A, id: 'withoutObserve' });
    const unobservedHandle = await routing.start(baseRequest('withoutObserve'));
    await expect(
      routing.observeCommand?.(unobservedHandle, 'ls'),
    ).rejects.toThrow(RoutingRuntimeProviderError);
  });

  it('returns undefined from reconcileStart when the target provider does not define it', async () => {
    const kimi = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { kimi },
      defaultProvider: 'kimi',
      route: () => undefined,
    });

    await routing.syncAgent(AGENT_A);
    const result = await routing.reconcileStart?.(baseRequest(AGENT_A.id));
    expect(result).toBeUndefined();
  });

  it('forwards reconcileStart and wraps the handle when the target provider defines it', async () => {
    const kimi = createStubProvider({
      withReconcileStart: true,
      startHandleId: 'reconciled-1',
    });
    const routing = createRoutingRuntimeProvider({
      providers: { kimi },
      defaultProvider: 'kimi',
      route: () => undefined,
    });

    await routing.syncAgent(AGENT_A);
    const handle = await routing.reconcileStart?.(baseRequest(AGENT_A.id));
    expect(handle).toEqual({ id: 'kimi reconciled-1' });
  });

  it('forwards reconcileStart to defaultProvider for an agent that was never synced (process-restart recovery), wrapping with the default provider prefix', async () => {
    const kimi = createStubProvider();
    const managed = createStubProvider({
      withReconcileStart: true,
      startHandleId: 'recovered-1',
    });
    const routing = createRoutingRuntimeProvider({
      providers: { kimi, managed },
      defaultProvider: 'managed',
      route: () => undefined,
    });

    // No syncAgent call at all: simulates agentRuntimes being empty after a
    // process restart while a session may still exist upstream.
    const handle = await routing.reconcileStart?.(baseRequest('never-synced'));

    expect(handle).toEqual({ id: 'managed recovered-1' });
    expect(managed.calls.map((c) => c.method)).toEqual(['reconcileStart']);
    expect(kimi.calls).toEqual([]);
  });

  it('round-trips the wrapped handle id through events/send/resume/collectOutput/usage/cleanup', async () => {
    const kimi = createStubProvider({ startHandleId: 'round-trip-1' });
    const routing = createRoutingRuntimeProvider({
      providers: { kimi },
      defaultProvider: 'kimi',
      route: () => undefined,
    });

    await routing.syncAgent(AGENT_A);
    const handle = await routing.start(baseRequest(AGENT_A.id));
    expect(handle).toEqual({ id: 'kimi round-trip-1' });

    const iterator = routing.events(handle)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.id).toBe('evt-1');

    await routing.send(handle, { text: 'hi' });
    await routing.resume(handle, { resumed: true });
    await routing.collectOutput(handle);
    await routing.usage(handle);
    await routing.cleanup(handle);

    for (const method of [
      'events',
      'send',
      'resume',
      'collectOutput',
      'usage',
      'cleanup',
    ]) {
      const call = kimi.calls.find((c) => c.method === method);
      expect(call?.args[0]).toEqual({ id: 'round-trip-1' });
    }

    const sendCall = kimi.calls.find((c) => c.method === 'send');
    expect(sendCall?.args[1]).toEqual({ text: 'hi' });
    const resumeCall = kimi.calls.find((c) => c.method === 'resume');
    expect(resumeCall?.args[1]).toEqual({ resumed: true });
  });

  it('preserves every non-id field of a managed-shaped handle across the wrap/unwrap round trip', async () => {
    // The managed provider returns a ManagedAgentsRuntimeHandle whose
    // ownershipCapability/runId/stepId/credentialRefs/uploadedFileIds/
    // deadlineAt fields ownership assertion and cleanup read back off the
    // handle. Rebuilding a bare {id} in the facade silently breaks them.
    const richHandle = {
      id: 'session-1',
      ownershipCapability: 'cap-abc',
      runId: 'run-1',
      stepId: 'step-1',
      credentialRefs: ['vault_1'],
      uploadedFileIds: ['file_1'],
      deadlineAt: '2026-01-01T00:00:00Z',
    };
    const managed = createStubProvider();
    (managed as { start: RuntimeProvider['start'] }).start = async (
      request: RuntimeStartRequest,
    ) => {
      (managed.calls as Call[]).push({ method: 'start', args: [request] });
      return richHandle as RuntimeHandle;
    };
    const routing = createRoutingRuntimeProvider({
      providers: { kimi: createStubProvider(), managed },
      defaultProvider: 'managed',
      route: () => 'managed',
    });

    await routing.syncAgent(AGENT_A);
    const handle = await routing.start(baseRequest(AGENT_A.id));
    expect(handle).toEqual({ ...richHandle, id: 'managed session-1' });

    await routing.cancel(handle, 'done');
    await routing.collectOutput(handle);

    for (const method of ['cancel', 'collectOutput']) {
      const call = managed.calls.find((c) => c.method === method);
      expect(call?.args[0]).toEqual(richHandle);
    }
  });

  it('dispatches a bare (unprefixed) handle to defaultProvider completely unchanged', async () => {
    // Every managed-only run persists a bare handle: its composition never
    // built this facade. A facade that is nonetheless in play (the control
    // plane builds one whenever kimi is configured) must pass it straight
    // through, not reject it as malformed.
    const kimi = createStubProvider();
    const managed = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { kimi, managed },
      defaultProvider: 'managed',
      route: () => undefined,
    });

    const bare = {
      id: 'session_abc123',
      ownershipCapability: 'cap-abc',
    } as RuntimeHandle;
    await routing.cancel(bare, 'stop');
    await routing.cleanup(bare);

    expect(managed.calls.map((c) => c.method)).toEqual(['cancel', 'cleanup']);
    expect(managed.calls[0]?.args[0]).toBe(bare);
    expect(kimi.calls).toEqual([]);
  });

  it('still routes a kimi-prefixed handle to kimi and still throws on an unknown prefix', async () => {
    const kimi = createStubProvider();
    const managed = createStubProvider();
    const routing = createRoutingRuntimeProvider({
      providers: { kimi, managed },
      defaultProvider: 'managed',
      route: () => undefined,
    });

    await routing.cancel({ id: 'kimi kimi_abc123' }, 'stop');
    expect(kimi.calls.map((c) => c.method)).toEqual(['cancel']);
    expect(kimi.calls[0]?.args[0]).toEqual({ id: 'kimi_abc123' });
    expect(managed.calls).toEqual([]);

    await expect(routing.cancel({ id: 'nope session-1' })).rejects.toThrow(
      RoutingRuntimeProviderError,
    );
  });

  it('rejects an empty providers map', () => {
    expect(() =>
      createRoutingRuntimeProvider({
        providers: {},
        defaultProvider: 'kimi',
        route: () => undefined,
      }),
    ).toThrow(RoutingRuntimeProviderError);
  });

  it('rejects a defaultProvider not present in providers', () => {
    const kimi = createStubProvider();
    expect(() =>
      createRoutingRuntimeProvider({
        providers: { kimi },
        defaultProvider: 'nonexistent',
        route: () => undefined,
      }),
    ).toThrow(RoutingRuntimeProviderError);
  });
});
