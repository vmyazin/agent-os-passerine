import { isoTimestamp, persistenceId, type RunStatus } from '@agentos/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { InMemoryWorkflowCheckpointStore } from '../trigger/checkpoint-store.js';
import { FeatureWorkflowTaskTransientError } from '../trigger/types.js';
import {
  createLocalDirectDispatcher,
  recoverLocalDirectRuns,
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

const recoveryCreatedAt = '2026-08-24T09:00:00.000Z';
const recoveryNow = '2026-09-02T09:00:00.000Z';
const neverExpires = '2099-01-01T00:00:00.000Z';

/** The owner string the workflow derives from this dispatcher's execution. */
const localOwner = (runId: string, generation = 0) =>
  `workflow:local-direct:${runId}:${String(generation)}:local-direct`;

/** The owner string the workflow derives from a real Trigger execution. */
const triggerOwner = (triggerRunId: string) =>
  `workflow:${triggerRunId}:20260824.1`;

async function seedProject(repository: InMemoryDomainRepository) {
  const at = isoTimestamp(recoveryCreatedAt);
  await repository.createProject({
    id: persistenceId('project', 'project-1'),
    name: 'Local direct',
    createdAt: at,
    updatedAt: at,
  });
}

async function seedRun(
  repository: InMemoryDomainRepository,
  input: {
    readonly id: string;
    readonly status: RunStatus;
    readonly createdAt?: string;
    readonly pipeline?: string;
  },
) {
  const at = isoTimestamp(input.createdAt ?? recoveryCreatedAt);
  return repository.createRun({
    id: persistenceId('run', input.id),
    projectId: persistenceId('project', 'project-1'),
    pipeline: input.pipeline ?? 'feature',
    status: input.status,
    createdAt: at,
    updatedAt: at,
  });
}

async function seedEffect(
  checkpoints: InMemoryWorkflowCheckpointStore,
  input: {
    readonly key: string;
    readonly runId: string;
    readonly ownerId: string;
    readonly succeed?: boolean;
  },
) {
  const claimed = await checkpoints.claimEffect(
    {
      key: input.key,
      runId: input.runId,
      kind: 'workflow-step',
      inputFingerprint: 'f'.repeat(64),
      createdAt: recoveryCreatedAt,
      updatedAt: recoveryCreatedAt,
    },
    {
      ownerId: input.ownerId,
      now: recoveryCreatedAt,
      leaseExpiresAt: neverExpires,
    },
  );
  if (input.succeed !== true) return claimed;
  const lease = {
    key: input.key,
    ownerId: input.ownerId,
    leaseVersion: claimed.leaseVersion,
  };
  await checkpoints.markEffectStarted(lease, recoveryCreatedAt);
  return checkpoints.completeEffect(
    lease,
    { replayed: true },
    recoveryCreatedAt,
  );
}

async function recordingRecovery() {
  const repository = new InMemoryDomainRepository();
  await seedProject(repository);
  const checkpoints = new InMemoryWorkflowCheckpointStore();
  const dispatched: {
    runId: string;
    projectId: string;
    pipeline: string;
    resumeGeneration: number;
  }[] = [];
  const released: string[] = [];
  const store = {
    listEffects: (runId: string) => checkpoints.listEffects(runId),
    releaseRunForResume: async (runId: string) => {
      released.push(runId);
      return checkpoints.releaseRunForResume(runId);
    },
  };
  return { repository, checkpoints, dispatched, released, store };
}

describe('local-direct restart recovery', () => {
  it('reopens and re-dispatches a running run this executor owned', async () => {
    const { repository, checkpoints, dispatched, released, store } =
      await recordingRecovery();
    await seedRun(repository, { id: 'run-a', status: 'running' });
    await seedEffect(checkpoints, {
      key: 'step:run-a:spec',
      runId: 'run-a',
      ownerId: localOwner('run-a'),
    });

    const result = await recoverLocalDirectRuns({
      repository,
      checkpoints: store,
      dispatch: async (input) => void dispatched.push({ ...input }),
      clock: () => recoveryNow,
    });

    expect(result).toEqual({ recovered: ['run-a'], skipped: [] });
    expect(released).toEqual(['run-a']);
    expect(dispatched).toEqual([
      {
        runId: 'run-a',
        projectId: 'project-1',
        pipeline: 'feature',
        resumeGeneration: 1,
      },
    ]);
    const reopened = await repository.getRun(persistenceId('run', 'run-a'));
    expect(reopened?.status).toBe('pending');
    // The workflow reads the generation and the deadline anchor back off this
    // event; without it the replay would key its ledger as generation zero.
    const events = await repository.listEvents(persistenceId('run', 'run-a'));
    expect(events.map((event) => event.type)).toEqual(['run.resumed']);
    expect(events[0]?.payload).toEqual({ generation: 1 });
    expect(events[0]?.occurredAt).toBe(recoveryNow);
  });

  it('brings a waiting run back to its approval without discarding paid work', async () => {
    const { repository, checkpoints, dispatched, store } =
      await recordingRecovery();
    await seedRun(repository, { id: 'run-w', status: 'waiting' });
    // The spec step that was already paid for, and the waitpoint the dead
    // process was parked on.
    await seedEffect(checkpoints, {
      key: 'step:run-w:spec',
      runId: 'run-w',
      ownerId: localOwner('run-w'),
      succeed: true,
    });
    await seedEffect(checkpoints, {
      key: 'waitpoint:run-w:approval_1',
      runId: 'run-w',
      ownerId: localOwner('run-w'),
    });

    const result = await recoverLocalDirectRuns({
      repository,
      checkpoints: store,
      dispatch: async (input) => void dispatched.push({ ...input }),
      clock: () => recoveryNow,
    });

    expect(result.recovered).toEqual(['run-w']);
    expect(dispatched[0]?.resumeGeneration).toBe(1);
    const remaining = await checkpoints.listEffects('run-w');
    // The succeeded step survives, so the replay reaches the approval from
    // storage instead of paying a model to redo it; only the unfinished
    // waitpoint is released.
    expect(remaining.map((effect) => effect.key)).toEqual(['step:run-w:spec']);
    expect(remaining[0]?.status).toBe('succeeded');
    expect(remaining[0]?.output).toEqual({ replayed: true });
  });

  it('leaves a run owned by the Trigger executor completely alone', async () => {
    const { repository, checkpoints, dispatched, released, store } =
      await recordingRecovery();
    await seedRun(repository, { id: 'run-t', status: 'running' });
    await seedEffect(checkpoints, {
      key: 'step:run-t:spec',
      runId: 'run-t',
      ownerId: triggerOwner('run_abc123'),
    });

    const result = await recoverLocalDirectRuns({
      repository,
      checkpoints: store,
      dispatch: async (input) => void dispatched.push({ ...input }),
      clock: () => recoveryNow,
    });

    expect(result).toEqual({ recovered: [], skipped: ['run-t'] });
    expect(released).toEqual([]);
    expect(dispatched).toEqual([]);
    const untouched = await repository.getRun(persistenceId('run', 'run-t'));
    expect(untouched?.status).toBe('running');
    expect(await repository.listEvents(persistenceId('run', 'run-t'))).toEqual(
      [],
    );
    expect((await checkpoints.listEffects('run-t')).length).toBe(1);
  });

  it('leaves a run with no effects at all alone', async () => {
    const { repository, dispatched, released, store } =
      await recordingRecovery();
    await seedRun(repository, { id: 'run-n', status: 'running' });

    const result = await recoverLocalDirectRuns({
      repository,
      checkpoints: store,
      dispatch: async (input) => void dispatched.push({ ...input }),
      clock: () => recoveryNow,
    });

    expect(result).toEqual({ recovered: [], skipped: ['run-n'] });
    expect(released).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(
      (await repository.getRun(persistenceId('run', 'run-n')))?.status,
    ).toBe('running');
  });

  it('derives the next generation from the resume suffix already on the keys', async () => {
    const { repository, checkpoints, dispatched, store } =
      await recordingRecovery();
    await seedRun(repository, { id: 'run-g', status: 'running' });
    await seedEffect(checkpoints, {
      key: 'step:run-g:spec',
      runId: 'run-g',
      ownerId: localOwner('run-g'),
    });
    await seedEffect(checkpoints, {
      key: 'workflow-start:run-g:resume:2',
      runId: 'run-g',
      ownerId: localOwner('run-g', 2),
    });

    await recoverLocalDirectRuns({
      repository,
      checkpoints: store,
      dispatch: async (input) => void dispatched.push({ ...input }),
      clock: () => recoveryNow,
    });

    expect(dispatched[0]?.resumeGeneration).toBe(3);
    const events = await repository.listEvents(persistenceId('run', 'run-g'));
    expect(events[0]?.payload).toEqual({ generation: 3 });
  });

  it('keeps sweeping when one run fails to recover', async () => {
    const { repository, checkpoints, dispatched, store } =
      await recordingRecovery();
    await seedRun(repository, {
      id: 'run-1',
      status: 'running',
      createdAt: '2026-08-24T09:00:00.000Z',
    });
    await seedRun(repository, {
      id: 'run-2',
      status: 'running',
      createdAt: '2026-08-24T10:00:00.000Z',
    });
    await seedRun(repository, {
      id: 'run-3',
      status: 'waiting',
      createdAt: '2026-08-24T11:00:00.000Z',
    });
    for (const runId of ['run-1', 'run-2', 'run-3'])
      await seedEffect(checkpoints, {
        key: `step:${runId}:spec`,
        runId,
        ownerId: localOwner(runId),
      });

    const result = await recoverLocalDirectRuns({
      repository,
      checkpoints: {
        listEffects: store.listEffects,
        releaseRunForResume: async (runId: string) => {
          if (runId === 'run-2') throw new Error('checkpoint release exploded');
          return store.releaseRunForResume(runId);
        },
      },
      dispatch: async (input) => void dispatched.push({ ...input }),
      clock: () => recoveryNow,
    });

    expect(result.recovered).toEqual(['run-1', 'run-3']);
    expect(result.skipped).toEqual(['run-2']);
    expect(dispatched.map((call) => call.runId)).toEqual(['run-1', 'run-3']);
    expect(
      (await repository.getRun(persistenceId('run', 'run-2')))?.status,
    ).toBe('running');
  });

  it('sweeps no more runs than the limit allows', async () => {
    const { repository, checkpoints, dispatched, store } =
      await recordingRecovery();
    for (const [index, runId] of ['run-1', 'run-2', 'run-3'].entries()) {
      await seedRun(repository, {
        id: runId,
        status: 'running',
        createdAt: `2026-08-24T0${String(index + 1)}:00:00.000Z`,
      });
      await seedEffect(checkpoints, {
        key: `step:${runId}:spec`,
        runId,
        ownerId: localOwner(runId),
      });
    }

    const result = await recoverLocalDirectRuns({
      repository,
      checkpoints: store,
      dispatch: async (input) => void dispatched.push({ ...input }),
      clock: () => recoveryNow,
      limit: 2,
    });

    expect(result.recovered).toEqual(['run-1', 'run-2']);
    expect(dispatched.length).toBe(2);
    expect(
      (await repository.getRun(persistenceId('run', 'run-3')))?.status,
    ).toBe('running');
  });
});

describe('recovery and live executions', () => {
  it('never reopens a run this process is executing', async () => {
    // The loop this prevents: a sweep that runs more than once sees its own
    // live run sitting in `running`, reopens it, and pays for the in-flight
    // step again. It happened five times in four minutes on 2026-09-03.
    const repository = new InMemoryDomainRepository();
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    const dispatch = vi.fn(async () => undefined);
    const released: string[] = [];
    const result = await recoverLocalDirectRuns({
      repository,
      checkpoints: {
        listEffects: async () => [
          {
            key: 'workflow-start:run-live',
            runId: 'run-live',
            kind: 'trigger-workflow-start',
            status: 'succeeded',
            ownerId: 'workflow:local-direct:run-live:0:local-direct',
            updatedAt: '2026-09-03T00:00:00.000Z',
          } as never,
        ],
        releaseRunForResume: async (runId: string) => {
          released.push(runId);
          return { released: 1 };
        },
      },
      isRunActive: (runId) => runId === 'run-live',
      dispatch,
    });
    expect(result.recovered).not.toContain('run-live');
    // Nothing was released and nothing was dispatched for it.
    expect(released).not.toContain('run-live');
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-live' }),
    );
  });

  it('reports a run as active only while it is executing', async () => {
    let release!: () => void;
    const dispatcher = createLocalDirectDispatcher({
      handler: {
        run: async () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
    });
    expect(dispatcher.isRunActive('run-1')).toBe(false);
    await dispatcher.startFeature('run-1', 'project-1');
    await vi.waitFor(() => expect(dispatcher.isRunActive('run-1')).toBe(true));
    // A different run is not confused for it, even though the prefix is close.
    expect(dispatcher.isRunActive('run-1-extra')).toBe(false);
    release();
    await dispatcher.settled();
    expect(dispatcher.isRunActive('run-1')).toBe(false);
  });
});
