import type { TriggerWorkflowDispatcher } from '../trigger/trigger-adapter.js';
import { FeatureWorkflowTaskTransientError } from '../trigger/types.js';

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
