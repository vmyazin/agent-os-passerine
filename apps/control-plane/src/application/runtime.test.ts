import type {
  RuntimeEvent,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeStartRequest,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import {
  assertKimiHandleSupported,
  composeCancellationRuntime,
} from './runtime';

type Call = { readonly method: string; readonly args: readonly unknown[] };

function stubProvider(startHandleId: string): RuntimeProvider & {
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const record = (method: string, ...args: unknown[]) =>
    calls.push({ method, args });
  return {
    calls,
    async syncAgent(agent) {
      record('syncAgent', agent);
    },
    async syncEnvironment(environment) {
      record('syncEnvironment', environment);
    },
    async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
      record('start', request);
      return { id: startHandleId };
    },
    async reconcileStart(
      request: RuntimeStartRequest,
    ): Promise<RuntimeHandle | undefined> {
      record('reconcileStart', request);
      return { id: startHandleId };
    },
    events(handle): AsyncIterable<RuntimeEvent> {
      record('events', handle);
      return { async *[Symbol.asyncIterator]() {} };
    },
    async send(handle, message) {
      record('send', handle, message);
    },
    async resume(handle, input) {
      record('resume', handle, input);
    },
    async cancel(handle, reason) {
      record('cancel', handle, reason);
    },
    async collectOutput(handle) {
      record('collectOutput', handle);
      return { artifacts: [] };
    },
    async usage(handle) {
      record('usage', handle);
      return { inputTokens: 0, outputTokens: 0, runtimeMs: 0 };
    },
    async cleanup(handle) {
      record('cleanup', handle);
    },
  };
}

const START_REQUEST: RuntimeStartRequest = {
  runId: 'run-1',
  stepId: 'step-1',
  agentId: 'agent-1',
  environmentId: 'env-1',
  input: {},
};

describe('composeCancellationRuntime', () => {
  it('returns the managed provider untouched when kimi is not configured', () => {
    const managed = stubProvider('session_abc');
    expect(composeCancellationRuntime({ managed, kimi: undefined })).toBe(
      managed,
    );
  });

  it('passes a bare managed handle through to the managed provider unmodified while kimi is configured', async () => {
    const managed = stubProvider('session_abc');
    const kimi = stubProvider('kimi_abc');
    const runtime = composeCancellationRuntime({ managed, kimi });

    const bare = { id: 'session_abc123' };
    await runtime.cancel(bare, 'stop');
    await runtime.cleanup(bare);

    expect(managed.calls.map((c) => c.method)).toEqual(['cancel', 'cleanup']);
    expect(managed.calls[0]?.args[0]).toBe(bare);
    expect(kimi.calls).toEqual([]);
  });

  it('routes a kimi-prefixed handle to the kimi provider with the prefix stripped', async () => {
    const managed = stubProvider('session_abc');
    const kimi = stubProvider('kimi_abc');
    const runtime = composeCancellationRuntime({ managed, kimi });

    await runtime.cancel({ id: 'kimi kimi_abc123' }, 'stop');

    expect(kimi.calls.map((c) => c.method)).toEqual(['cancel']);
    expect(kimi.calls[0]?.args[0]).toEqual({ id: 'kimi_abc123' });
    expect(managed.calls).toEqual([]);
  });

  it('never prefixes the handle it recovers, keeping worker parity for managed sessions', async () => {
    const managed = stubProvider('session_abc');
    const kimi = stubProvider('kimi_abc');
    const runtime = composeCancellationRuntime({ managed, kimi });

    await expect(runtime.reconcileStart?.(START_REQUEST)).resolves.toEqual({
      id: 'session_abc',
    });
    await expect(runtime.start(START_REQUEST)).resolves.toEqual({
      id: 'session_abc',
    });
    expect(kimi.calls).toEqual([]);
  });
});

describe('assertKimiHandleSupported', () => {
  it('rejects a kimi-prefixed handle when kimi is not configured', () => {
    expect(() =>
      assertKimiHandleSupported({ id: 'kimi abc123' }, false),
    ).toThrow(
      /kimi runtime is not configured; cannot operate on handle 'kimi abc123'/,
    );
  });

  it('allows a kimi-prefixed handle when kimi is configured', () => {
    expect(() =>
      assertKimiHandleSupported({ id: 'kimi abc123' }, true),
    ).not.toThrow();
  });

  it('never rejects a bare managed handle id regardless of kimi configuration', () => {
    expect(() =>
      assertKimiHandleSupported({ id: 'session_abc123' }, false),
    ).not.toThrow();
    expect(() =>
      assertKimiHandleSupported({ id: 'session_abc123' }, true),
    ).not.toThrow();
  });

  it('only matches the exact "kimi " delimiter prefix, not any id merely starting with the letters kimi', () => {
    expect(() =>
      assertKimiHandleSupported({ id: 'kimichunk_abc123' }, false),
    ).not.toThrow();
  });
});
