import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeatureWorkflowTaskTransientError } from '../trigger/types.js';
import {
  createLocalDirectDispatcher,
  LocalDirectGoalUnsupportedError,
  type LocalDirectDispatcher,
  type LocalDirectDispatcherOptions,
} from './dispatcher.js';

/**
 * `isExecutorUnavailable` is a module-private function in
 * `../trigger/outbox.ts` (declared, not exported, at line 278). It is
 * replicated here verbatim so the dispatcher's "lost execution" answer is
 * checked against the real predicate's logic rather than a paraphrase of it.
 */
function isExecutorUnavailable(
  state: { readonly status: string; readonly error?: string } | undefined,
): boolean {
  return (
    state?.status === 'SYSTEM_FAILURE' &&
    state.error?.includes('COULD_NOT_FIND_EXECUTOR') === true
  );
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recordingDispatcher(
  run: (payload: unknown, execution: unknown) => Promise<unknown>,
  options: Omit<LocalDirectDispatcherOptions, 'handler'> = {},
): {
  dispatcher: LocalDirectDispatcher;
  calls: { payload: unknown; execution: unknown }[];
} {
  const calls: { payload: unknown; execution: unknown }[] = [];
  const dispatcher = createLocalDirectDispatcher({
    ...options,
    handler: {
      async run(payload, execution) {
        calls.push({ payload, execution });
        return run(payload, execution);
      },
    },
  });
  return { dispatcher, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('local-direct dispatcher', () => {
  it('returns the reference and calls the handler with the task payload and execution', async () => {
    const { dispatcher, calls } = recordingDispatcher(async () => 'ok');

    await expect(
      dispatcher.startFeature('run-1', 'project-1'),
    ).resolves.toEqual({ externalRunRef: 'local-direct:run-1:0' });
    await dispatcher.settled();

    expect(calls).toEqual([
      {
        payload: { version: 'feature-task-payload-v1', runId: 'run-1' },
        execution: {
          taskVersion: 'local-direct',
          deploymentVersion: 'development-unversioned',
          triggerRunId: 'local-direct:run-1:0',
        },
      },
    ]);
    await expect(dispatcher.retrieve('local-direct:run-1:0')).resolves.toEqual({
      status: 'COMPLETED',
    });
  });

  it('reports the configured deployment version to the handler', async () => {
    const { dispatcher, calls } = recordingDispatcher(async () => 'ok', {
      deploymentVersion: 'abc1234',
    });

    await dispatcher.startFeature('run-1', 'project-1');
    await dispatcher.settled();

    expect(calls[0]?.execution).toMatchObject({ deploymentVersion: 'abc1234' });
  });

  it('returns before the handler resolves', async () => {
    const gate = deferred();
    let handlerSettled = false;
    const { dispatcher } = recordingDispatcher(async () => {
      await gate.promise;
      handlerSettled = true;
      return 'ok';
    });

    await expect(
      dispatcher.startFeature('run-1', 'project-1'),
    ).resolves.toEqual({ externalRunRef: 'local-direct:run-1:0' });
    expect(handlerSettled).toBe(false);
    await expect(dispatcher.retrieve('local-direct:run-1:0')).resolves.toEqual({
      status: 'EXECUTING',
    });

    gate.resolve();
    await dispatcher.settled();
    expect(handlerSettled).toBe(true);
  });

  it('retries a transient failure exactly once, after the retry delay', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { dispatcher } = recordingDispatcher(async () => {
      attempts += 1;
      if (attempts === 1)
        throw new FeatureWorkflowTaskTransientError('executor hiccup');
      return 'ok';
    });

    await dispatcher.startFeature('run-1', 'project-1');
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    await expect(dispatcher.retrieve('local-direct:run-1:0')).resolves.toEqual({
      status: 'EXECUTING',
    });

    await vi.advanceTimersByTimeAsync(1);
    await dispatcher.settled();

    expect(attempts).toBe(2);
    await expect(dispatcher.retrieve('local-direct:run-1:0')).resolves.toEqual({
      status: 'COMPLETED',
    });
  });

  it('gives up after a second transient failure', async () => {
    let attempts = 0;
    const { dispatcher } = recordingDispatcher(
      async () => {
        attempts += 1;
        throw new FeatureWorkflowTaskTransientError('still hiccuping');
      },
      { retryDelayMs: 0 },
    );

    await dispatcher.startFeature('run-1', 'project-1');
    await dispatcher.settled();

    expect(attempts).toBe(2);
    await expect(dispatcher.retrieve('local-direct:run-1:0')).resolves.toEqual({
      status: 'FAILED',
      error: 'still hiccuping',
    });
  });

  it('does not retry a non-transient failure and reports it as FAILED', async () => {
    let attempts = 0;
    const { dispatcher } = recordingDispatcher(
      async () => {
        attempts += 1;
        throw new Error('workflow rejected the run');
      },
      { retryDelayMs: 0 },
    );

    await dispatcher.startFeature('run-1', 'project-1');
    await dispatcher.settled();

    expect(attempts).toBe(1);
    await expect(dispatcher.retrieve('local-direct:run-1:0')).resolves.toEqual({
      status: 'FAILED',
      error: 'workflow rejected the run',
    });
  });

  it('never lets a handler failure escape as an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { dispatcher } = recordingDispatcher(
        () => Promise.reject(new Error('boom')),
        { retryDelayMs: 0 },
      );
      await dispatcher.startFeature('run-1', 'project-1');
      await dispatcher.settled();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('answers an unknown reference with the shape the outbox reads as an unavailable executor', async () => {
    const { dispatcher } = recordingDispatcher(async () => 'ok');

    const state = await dispatcher.retrieve('local-direct:run-lost:0');

    expect(state).toEqual({
      status: 'SYSTEM_FAILURE',
      error:
        'COULD_NOT_FIND_EXECUTOR: local-direct execution local-direct:run-lost:0 was lost',
    });
    expect(isExecutorUnavailable(state)).toBe(true);
  });

  it('does not report a live or finished execution as an unavailable executor', async () => {
    const { dispatcher } = recordingDispatcher(async () => 'ok');

    await dispatcher.startFeature('run-1', 'project-1');
    expect(
      isExecutorUnavailable(await dispatcher.retrieve('local-direct:run-1:0')),
    ).toBe(false);
    await dispatcher.settled();
    expect(
      isExecutorUnavailable(await dispatcher.retrieve('local-direct:run-1:0')),
    ).toBe(false);
  });

  it('refuses a goal run by name', async () => {
    const { dispatcher, calls } = recordingDispatcher(async () => 'ok');

    await expect(dispatcher.startGoal('run-9', 'project-1')).rejects.toThrow(
      LocalDirectGoalUnsupportedError,
    );
    await expect(dispatcher.startGoal('run-9', 'project-1')).rejects.toThrow(
      /run-9/,
    );
    await expect(dispatcher.startGoal('run-9', 'project-1')).rejects.toThrow(
      /Trigger executor/,
    );
    expect(calls).toEqual([]);
  });

  it('aborts a running execution on cancel', async () => {
    let observedAbort = false;
    const held: { current?: LocalDirectDispatcher } = {};
    const entered = deferred();
    const dispatcher = createLocalDirectDispatcher({
      handler: {
        async run(_payload, execution) {
          const ref = (execution as { readonly triggerRunId: string })
            .triggerRunId;
          const signal = held.current?.abortSignal(ref);
          expect(signal?.aborted).toBe(false);
          entered.resolve();
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          observedAbort = signal?.aborted === true;
          return 'stopped';
        },
      },
    });

    held.current = dispatcher;

    await dispatcher.startFeature('run-1', 'project-1');
    await entered.promise;
    await dispatcher.cancel('local-direct:run-1:0');
    await dispatcher.settled();

    expect(observedAbort).toBe(true);
    expect(dispatcher.abortSignal('local-direct:run-1:0')?.aborted).toBe(true);
  });

  it('ignores a cancel for a reference it never had', async () => {
    const { dispatcher } = recordingDispatcher(async () => 'ok');

    await expect(
      dispatcher.cancel('local-direct:never-started:3'),
    ).resolves.toBeUndefined();
  });

  it('fails an execution cancelled before the queue reached it', async () => {
    const gate = deferred();
    const { dispatcher } = recordingDispatcher(async () => {
      await gate.promise;
      return 'ok';
    });

    await dispatcher.startFeature('run-1', 'project-1');
    await dispatcher.startFeature('run-2', 'project-1');
    await dispatcher.cancel('local-direct:run-2:0');
    gate.resolve();
    await dispatcher.settled();

    await expect(dispatcher.retrieve('local-direct:run-2:0')).resolves.toEqual({
      status: 'FAILED',
      error: 'local-direct execution cancelled before it started',
    });
  });

  it('runs one execution at a time', async () => {
    let active = 0;
    let peak = 0;
    const gates = [deferred(), deferred()];
    let index = 0;
    const { dispatcher } = recordingDispatcher(async () => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = gates[index];
      index += 1;
      await gate?.promise;
      active -= 1;
      return 'ok';
    });

    await Promise.all([
      dispatcher.startFeature('run-1', 'project-1'),
      dispatcher.startFeature('run-2', 'project-1'),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(1);

    gates[0]?.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(1);
    gates[1]?.resolve();
    await dispatcher.settled();

    expect(peak).toBe(1);
    await expect(dispatcher.retrieve('local-direct:run-2:0')).resolves.toEqual({
      status: 'COMPLETED',
    });
  });

  it('does not schedule a second execution for a reference already in flight', async () => {
    const gate = deferred();
    const { dispatcher, calls } = recordingDispatcher(async () => {
      await gate.promise;
      return 'ok';
    });

    await dispatcher.startFeature('run-1', 'project-1');
    await dispatcher.startFeature('run-1', 'project-1', 1);
    gate.resolve();
    await dispatcher.settled();

    expect(calls).toHaveLength(1);
  });

  it('gives a resumed run its own reference', async () => {
    const { dispatcher, calls } = recordingDispatcher(async () => 'ok');

    await expect(
      dispatcher.startFeature('run-1', 'project-1', 0, 0),
    ).resolves.toEqual({ externalRunRef: 'local-direct:run-1:0' });
    await expect(
      dispatcher.startFeature('run-1', 'project-1', 0, 2),
    ).resolves.toEqual({ externalRunRef: 'local-direct:run-1:2' });
    await dispatcher.settled();

    expect(calls.map((call) => call.execution)).toEqual([
      expect.objectContaining({ triggerRunId: 'local-direct:run-1:0' }),
      expect.objectContaining({ triggerRunId: 'local-direct:run-1:2' }),
    ]);
  });

  it('refuses a resume generation that is not a non-negative integer', async () => {
    const { dispatcher } = recordingDispatcher(async () => 'ok');

    await expect(
      dispatcher.startFeature('run-1', 'project-1', 0, -1),
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      dispatcher.startFeature('run-1', 'project-1', 0, 1.5),
    ).rejects.toThrow(/non-negative integer/);
  });

  it('stamps the execution record from the injected clock', async () => {
    const { dispatcher } = recordingDispatcher(async () => 'ok', {
      clock: () => '2026-09-02T00:00:00.000Z',
    });

    await dispatcher.startFeature('run-1', 'project-1');
    await dispatcher.settled();

    expect(dispatcher.inspect('local-direct:run-1:0')).toEqual({
      externalRunRef: 'local-direct:run-1:0',
      runId: 'run-1',
      generation: 0,
      status: 'completed',
      startedAt: '2026-09-02T00:00:00.000Z',
      completedAt: '2026-09-02T00:00:00.000Z',
      attempts: 1,
    });
    expect(dispatcher.inspect('local-direct:run-1:9')).toBeUndefined();
  });

  it('refuses starts after close and aborts what is in flight', async () => {
    let observedAbort = false;
    const held: { current?: LocalDirectDispatcher } = {};
    const entered = deferred();
    const dispatcher = createLocalDirectDispatcher({
      handler: {
        async run(_payload, execution) {
          const ref = (execution as { readonly triggerRunId: string })
            .triggerRunId;
          entered.resolve();
          await new Promise<void>((resolve) => {
            held.current
              ?.abortSignal(ref)
              ?.addEventListener('abort', () => resolve(), { once: true });
          });
          observedAbort = true;
          return 'stopped';
        },
      },
    });
    held.current = dispatcher;

    await dispatcher.startFeature('run-1', 'project-1');
    await entered.promise;
    await dispatcher.close();

    expect(observedAbort).toBe(true);
    await expect(dispatcher.startFeature('run-2', 'project-1')).rejects.toThrow(
      /closed/,
    );
  });
});
