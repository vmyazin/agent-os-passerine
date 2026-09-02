import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  isoTimestamp,
  persistenceId,
  type DomainRepository,
  type RunStatus,
  type WorkflowRun,
} from '@agentos/core';

import type { TriggerWorkflowDispatcher } from '../trigger/trigger-adapter.js';
import {
  FeatureWorkflowTaskTransientError,
  type WorkflowCheckpointStore,
} from '../trigger/types.js';
import { RUN_RESUMED_EVENT } from '../trigger/workflow.js';

/**
 * The feature task handler, seen through the narrowest hole that lets this
 * driver call it. The real handler is
 * `FeatureWorkflowTaskHandler` from `../trigger/task.js`; keeping the local
 * shape structural avoids dragging the Trigger SDK import graph into a process
 * that has deliberately left Trigger behind.
 */
export interface LocalDirectTaskHandler {
  run(payload: unknown, execution: unknown): Promise<unknown>;
}

export interface LocalDirectDispatcherOptions {
  readonly handler: LocalDirectTaskHandler;
  readonly clock?: () => string | Date;
  readonly deploymentVersion?: string;
  /** Delay before the single transient retry. Defaults to one second. */
  readonly retryDelayMs?: number;
}

export type LocalDirectExecutionStatus = 'executing' | 'completed' | 'failed';

export interface LocalDirectExecutionSnapshot {
  readonly externalRunRef: string;
  readonly runId: string;
  readonly generation: number;
  readonly status: LocalDirectExecutionStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly attempts: number;
}

export interface LocalDirectDispatcher extends TriggerWorkflowDispatcher {
  /**
   * Resolves once every execution scheduled so far has settled. Tests await
   * it; nothing in production depends on the queue being empty.
   */
  settled(): Promise<void>;
  /** Alias of {@link LocalDirectDispatcher.settled}, for readability at call sites. */
  idle(): Promise<void>;
  /** The in-memory record for a reference, or `undefined` if this process never had it. */
  inspect(externalRunRef: string): LocalDirectExecutionSnapshot | undefined;
  /**
   * The abort signal `cancel` trips. The execution object handed to the
   * handler is byte-for-byte the one the Trigger task passes, so a composition
   * that wants cancellation reads the signal from here instead.
   */
  abortSignal(externalRunRef: string): AbortSignal | undefined;
  /** Refuses further starts and aborts whatever is in flight. */
  close(): Promise<void>;
}

/** Thrown by `startGoal`: this executor runs feature pipelines only. */
export class LocalDirectGoalUnsupportedError extends Error {
  constructor(runId: string) {
    super(
      `goal runs are not supported on the local-direct executor (run ${runId}); use the Trigger executor for goal pipelines`,
    );
    this.name = 'LocalDirectGoalUnsupportedError';
  }
}

/** Thrown when a start arrives after `close`. */
export class LocalDirectDispatcherClosedError extends Error {
  constructor(runId: string) {
    super(`local-direct dispatcher is closed; cannot start run ${runId}`);
    this.name = 'LocalDirectDispatcherClosedError';
  }
}

const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_DEPLOYMENT_VERSION = 'development-unversioned';
const MAX_ERROR_LENGTH = 500;

interface LocalDirectExecution {
  readonly runId: string;
  readonly generation: number;
  readonly controller: AbortController;
  readonly startedAt: string;
  status: LocalDirectExecutionStatus;
  completedAt?: string;
  error?: string;
  attempts: number;
}

/**
 * The reference is the whole identity of a local execution: it names the run
 * and the resume generation, mirroring what the Trigger idempotency key
 * encodes, so a resumed run never collides with the attempt it replaces.
 */
function executionReference(runId: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new Error('resume generation must be a non-negative integer');
  return `local-direct:${runId}:${String(generation)}`;
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown local-direct execution failure';
  const text =
    message === '' ? 'unknown local-direct execution failure' : message;
  return text.slice(0, MAX_ERROR_LENGTH);
}

/**
 * `instanceof` alone would miss an error thrown by a second copy of the
 * adapters module, and a retry policy that silently degrades to "permanent" is
 * the failure mode this driver exists to avoid.
 */
function isTransient(error: unknown): boolean {
  return (
    error instanceof FeatureWorkflowTaskTransientError ||
    (error instanceof Error &&
      error.name === 'FeatureWorkflowTaskTransientError')
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createLocalDirectDispatcher(
  options: LocalDirectDispatcherOptions,
): LocalDirectDispatcher {
  const executions = new Map<string, LocalDirectExecution>();
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const deploymentVersion =
    options.deploymentVersion ?? DEFAULT_DEPLOYMENT_VERSION;
  // One execution at a time. The budget admission function is the real
  // authority on concurrency; this chain is only a runaway guard, so a queue
  // of promises is enough.
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const now = (): string => {
    const value = options.clock?.() ?? new Date();
    return typeof value === 'string' ? value : value.toISOString();
  };

  function snapshot(
    ref: string,
    execution: LocalDirectExecution,
  ): LocalDirectExecutionSnapshot {
    return {
      externalRunRef: ref,
      runId: execution.runId,
      generation: execution.generation,
      status: execution.status,
      startedAt: execution.startedAt,
      attempts: execution.attempts,
      ...(execution.completedAt === undefined
        ? {}
        : { completedAt: execution.completedAt }),
      ...(execution.error === undefined ? {} : { error: execution.error }),
    };
  }

  function fail(execution: LocalDirectExecution, message: string): void {
    execution.status = 'failed';
    execution.error = message;
    execution.completedAt = now();
  }

  async function invoke(
    ref: string,
    execution: LocalDirectExecution,
  ): Promise<void> {
    const payload = {
      version: 'feature-task-payload-v1',
      runId: execution.runId,
    };
    const context = {
      taskVersion: 'local-direct',
      deploymentVersion,
      triggerRunId: ref,
    };
    if (execution.controller.signal.aborted) {
      fail(execution, 'local-direct execution cancelled before it started');
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      execution.attempts += 1;
      try {
        await options.handler.run(payload, context);
        execution.status = 'completed';
        execution.completedAt = now();
        return;
      } catch (error) {
        const message = errorMessage(error);
        // The Trigger task rethrows only a transient error for its bounded
        // retry and aborts on everything else; this mirrors that policy with
        // exactly one retry, in-process.
        if (attempt === 0 && isTransient(error)) {
          await delay(retryDelayMs, execution.controller.signal);
          if (execution.controller.signal.aborted) {
            fail(execution, message);
            return;
          }
          continue;
        }
        fail(execution, message);
        return;
      }
    }
  }

  function schedule(ref: string, execution: LocalDirectExecution): void {
    // Nothing may escape into an unhandled rejection: this promise is the tail
    // of a chain no caller awaits.
    queue = queue.then(async () => {
      try {
        await invoke(ref, execution);
      } catch (error) {
        fail(execution, errorMessage(error));
      }
    });
  }

  function start(
    runId: string,
    resumeGeneration: number,
  ): { readonly externalRunRef: string } {
    if (closed) throw new LocalDirectDispatcherClosedError(runId);
    const ref = executionReference(runId, resumeGeneration);
    const existing = executions.get(ref);
    // A start that lands on a reference already in flight is the same work;
    // running it twice would double the model spend it guards.
    if (existing?.status === 'executing') return { externalRunRef: ref };
    const execution: LocalDirectExecution = {
      runId,
      generation: resumeGeneration,
      controller: new AbortController(),
      startedAt: now(),
      status: 'executing',
      attempts: 0,
    };
    executions.set(ref, execution);
    schedule(ref, execution);
    return { externalRunRef: ref };
  }

  const dispatcher: LocalDirectDispatcher = {
    // `attempt` is part of the port and deliberately unused: Trigger needs it
    // to mint a fresh idempotency key, while a local reference is already
    // unique per run and generation.
    async startFeature(runId, _projectId, _attempt, resumeGeneration = 0) {
      return start(runId, resumeGeneration);
    },
    async startGoal(runId) {
      throw new LocalDirectGoalUnsupportedError(runId);
    },
    async retrieve(externalRunRef) {
      const execution = executions.get(externalRunRef);
      if (execution === undefined)
        return {
          // Read literally by `isExecutorUnavailable` in trigger/outbox.ts,
          // which requires both the SYSTEM_FAILURE status and this marker in
          // the message before it will re-dispatch or fail the run.
          status: 'SYSTEM_FAILURE',
          error: `COULD_NOT_FIND_EXECUTOR: local-direct execution ${externalRunRef} was lost`,
        };
      if (execution.status === 'executing') return { status: 'EXECUTING' };
      if (execution.status === 'completed') return { status: 'COMPLETED' };
      return {
        status: 'FAILED',
        ...(execution.error === undefined ? {} : { error: execution.error }),
      };
    },
    async cancel(externalRunRef) {
      executions.get(externalRunRef)?.controller.abort();
    },
    async settled() {
      await queue;
    },
    async idle() {
      await queue;
    },
    inspect(externalRunRef) {
      const execution = executions.get(externalRunRef);
      return execution === undefined
        ? undefined
        : snapshot(externalRunRef, execution);
    },
    abortSignal(externalRunRef) {
      return executions.get(externalRunRef)?.controller.signal;
    },
    async close() {
      closed = true;
      for (const execution of executions.values())
        if (execution.status === 'executing') execution.controller.abort();
      await queue;
    },
  };
  return Object.freeze(dispatcher);
}

/**
 * The statuses a worker that died mid-flight leaves behind. `running` is an
 * execution that was never finished; `waiting` is one parked on an approval
 * whose in-process waiter died with it. Both are terminal in practice on this
 * executor -- nothing re-attaches -- which is exactly the five-day `running`
 * run the 2026-08-28 evaluation found.
 */
const RECOVERABLE_RUN_STATUSES: readonly RunStatus[] = ['running', 'waiting'];

/**
 * The prefix on the `ownerId` of every effect this executor claimed.
 *
 * The workflow builds its owner string as
 * `workflow:<triggerRunId>:<taskVersion>` (`trigger/workflow.ts`), and this
 * dispatcher hands it `triggerRunId = local-direct:<runId>:<generation>`. So
 * ownership is readable from the effect row alone, which is the only way a
 * restarting process can tell its own abandoned work from another executor's
 * still-live work -- and telling them apart is the whole safety property
 * here. A run with no locally-owned effect is left completely untouched.
 */
const LOCAL_DIRECT_EFFECT_OWNER_PREFIX = 'workflow:local-direct:';

/** Matches the resume suffix the outbox mints for a regenerated effect key. */
const RESUME_GENERATION_PATTERN = /:resume:(\d+)$/;

const DEFAULT_RECOVERY_LIMIT = 100;

/**
 * The two checkpoint operations recovery needs, named so a caller can pass a
 * real {@link WorkflowCheckpointStore} (which satisfies this) without the
 * function claiming authority over the other twenty methods.
 */
export type LocalDirectRecoveryCheckpoints = Pick<
  WorkflowCheckpointStore,
  'listEffects' | 'releaseRunForResume'
>;

export interface LocalDirectRecoveryOptions {
  readonly repository: DomainRepository;
  readonly checkpoints: LocalDirectRecoveryCheckpoints;
  readonly dispatch: (input: {
    readonly runId: string;
    readonly projectId: string;
    readonly pipeline: string;
    readonly resumeGeneration: number;
  }) => Promise<void>;
  readonly clock?: () => string;
  /** How many unfinished runs one sweep will look at. Defaults to 100. */
  readonly limit?: number;
}

export interface LocalDirectRecoveryResult {
  /** Runs reopened and re-dispatched by this sweep. */
  readonly recovered: readonly string[];
  /**
   * Runs deliberately left alone: another executor's, never started, or one
   * whose own recovery failed. A failure is reported here rather than thrown,
   * because one bad run must not strand every other one.
   */
  readonly skipped: readonly string[];
}

function fingerprintOf(value: string): string {
  return createHash('sha256').update(canonicalJsonValue(value)).digest('hex');
}

/** True when any effect of this run was claimed by a local-direct execution. */
function ownedLocally(effects: readonly { ownerId?: string }[]): boolean {
  return effects.some(
    (effect) =>
      effect.ownerId?.startsWith(LOCAL_DIRECT_EFFECT_OWNER_PREFIX) === true,
  );
}

/**
 * The generation the next execution of this run must use -- derived exactly
 * as `ControlPlaneService.resumeRun` derives it, from the resume suffix on the
 * effect keys, so a resume started by the operator and one started by this
 * sweep can never land on the same generation.
 */
function nextResumeGeneration(effects: readonly { key: string }[]): number {
  return (
    effects.reduce((highest, effect) => {
      const match = RESUME_GENERATION_PATTERN.exec(effect.key);
      return match === null
        ? highest
        : Math.max(highest, Number.parseInt(match[1]!, 10));
    }, 0) + 1
  );
}

/**
 * Brings this executor's own in-flight runs back after the process that was
 * running them died.
 *
 * Trigger re-attaches to a task across a worker restart; this driver cannot,
 * so a run left `running` or `waiting` when the process went away stays that
 * way forever. This sweep is the replacement: it finds those runs, keeps only
 * the ones whose effects this executor owned, and puts each one back through
 * the same resume path an operator would use -- release the unfinished
 * checkpoints, reopen the run as `pending`, record the resume, dispatch the
 * next generation. Succeeded effects survive `releaseRunForResume`, so the
 * replay reaches where it stopped without paying a model again; a `waiting`
 * run in particular comes back to its approval for free.
 *
 * Deliberately a function rather than something the dispatcher's constructor
 * does: it writes to the database, and a constructor that writes is both
 * untestable and surprising.
 *
 * It never throws. Every per-run failure is recorded in `skipped` and the
 * sweep carries on, because a recovery pass that aborts halfway has left the
 * remaining runs in exactly the state it existed to fix.
 */
export async function recoverLocalDirectRuns(
  options: LocalDirectRecoveryOptions,
): Promise<LocalDirectRecoveryResult> {
  const limit = options.limit ?? DEFAULT_RECOVERY_LIMIT;
  const now = (): string => options.clock?.() ?? new Date().toISOString();
  const recovered: string[] = [];
  const skipped: string[] = [];

  const listed: WorkflowRun[] = [];
  for (const status of RECOVERABLE_RUN_STATUSES)
    listed.push(...(await options.repository.listRuns({ status, limit })));
  // One bounded, deterministic sweep across both statuses: oldest first,
  // because the run that has been stuck longest is the one an operator is
  // waiting on.
  const runs = listed
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    )
    .slice(0, limit);

  for (const run of runs) {
    try {
      const effects = await options.checkpoints.listEffects(run.id);
      if (!ownedLocally(effects)) {
        // Another executor's run, or one that never started. Touching it
        // would be this executor claiming work it does not own.
        skipped.push(run.id);
        continue;
      }
      const generation = nextResumeGeneration(effects);
      // Cleared before reopening: a replay that met a dead-lettered
      // checkpoint would refuse to continue and fail the run all over again.
      await options.checkpoints.releaseRunForResume(run.id);
      const at = isoTimestamp(now());
      const reopened = await options.repository.transitionRun(
        run.id,
        RECOVERABLE_RUN_STATUSES,
        { status: 'pending', error: null, output: null, updatedAt: at },
        run.stateVersion ?? 0,
      );
      if (reopened === undefined) {
        // Something else moved this run while the sweep was on it -- the
        // operator resumed or cancelled it. Theirs wins.
        skipped.push(run.id);
        continue;
      }
      // The resume event is not bookkeeping: the workflow reads it back for
      // both the generation that keys the usage ledger and the anchor for the
      // execution deadline. Without it a run that sat unfinished for days
      // would replay against a deadline measured from its creation and die
      // immediately, and its ledger keys would collide with money already
      // spent.
      await options.repository.appendEvent({
        runId: run.id,
        eventId: persistenceId(
          'event',
          `run-resumed:${run.id}:${String(generation)}`,
        ),
        fingerprint: fingerprintOf(
          `run-resumed:${run.id}:${String(generation)}`,
        ),
        type: RUN_RESUMED_EVENT,
        payload: { generation },
        occurredAt: at,
      });
      await options.dispatch({
        runId: run.id,
        projectId: run.projectId,
        pipeline: run.pipeline,
        resumeGeneration: generation,
      });
      recovered.push(run.id);
    } catch {
      // The reopened run is durable either way; a failed dispatch is retried
      // by reconciliation, and a run this sweep could not touch stays exactly
      // as it was.
      skipped.push(run.id);
    }
  }
  return { recovered, skipped };
}
