import { runs, tasks, wait } from '@trigger.dev/sdk';

import {
  FEATURE_WORKFLOW_TASK_ID,
  GOAL_WORKFLOW_TASK_ID,
  type WorkflowApprovalWaiter,
} from './types.js';
import {
  featureWorkflowQueueName,
  goalWorkflowQueueName,
} from './queue-names.js';

export interface TriggerTaskOptions {
  readonly idempotencyKey: string;
  readonly idempotencyKeyTTL: string;
  readonly queue?: string;
}

/** Stable local seam; no Trigger.dev SDK types cross this boundary. */
export interface TriggerSdkBoundary {
  triggerTask(
    taskId: string,
    payload: unknown,
    options: TriggerTaskOptions,
  ): Promise<{ readonly id: string }>;
  createWaitpoint(options: {
    readonly idempotencyKey: string;
    readonly idempotencyKeyTTL: string;
    readonly timeout: string;
    readonly tags: readonly string[];
  }): Promise<{ readonly id: string }>;
  waitForToken(id: string): Promise<{ readonly ok: boolean }>;
  completeWaitpoint(
    id: string,
    output: unknown,
  ): Promise<{ readonly success: boolean }>;
  cancelRun(id: string): Promise<void>;
  /**
   * What the executor did with a run this control plane handed off. Read-only
   * and best-effort: an unknown id, a revoked key, or an unreachable API all
   * answer `undefined` rather than throwing, because this exists to explain a
   * page and must never be the reason one fails to render.
   */
  retrieveRun(id: string): Promise<
    | {
        readonly status: string;
        readonly error?: string;
      }
    | undefined
  >;
}

export function createTriggerSdkBoundary(): TriggerSdkBoundary {
  const boundary: TriggerSdkBoundary = {
    async triggerTask(
      taskId: string,
      payload: unknown,
      options: TriggerTaskOptions,
    ) {
      const result = await tasks.trigger(taskId, payload, options);
      return { id: result.id };
    },
    async createWaitpoint(options: {
      readonly idempotencyKey: string;
      readonly idempotencyKeyTTL: string;
      readonly timeout: string;
      readonly tags: readonly string[];
    }) {
      const token = await wait.createToken({
        idempotencyKey: options.idempotencyKey,
        idempotencyKeyTTL: options.idempotencyKeyTTL,
        timeout: options.timeout,
        tags: [...options.tags],
      });
      // Deliberately discard url/publicAccessToken at the trusted boundary.
      return { id: token.id };
    },
    async waitForToken(id: string) {
      const result = await wait.forToken(id);
      return { ok: result.ok };
    },
    async completeWaitpoint(id: string, output: unknown) {
      const result = await wait.completeToken(id, output);
      return { success: result.success };
    },
    async cancelRun(id: string) {
      await runs.cancel(id);
    },
    async retrieveRun(id: string) {
      try {
        const run = (await runs.retrieve(id)) as {
          readonly status?: unknown;
          readonly error?: { readonly message?: unknown; readonly name?: unknown };
        };
        if (typeof run.status !== 'string') return undefined;
        const message = run.error?.message ?? run.error?.name;
        return {
          status: run.status,
          ...(typeof message === 'string' && message !== ''
            ? { error: message.slice(0, 500) }
            : {}),
        };
      } catch {
        return undefined;
      }
    },
  };
  return Object.freeze(boundary);
}

export interface TriggerWorkflowDispatcher {
  startFeature(
    runId: string,
    projectId: string,
  ): Promise<{ readonly externalRunRef: string }>;
  startGoal(
    runId: string,
    projectId: string,
  ): Promise<{ readonly externalRunRef: string }>;
  cancel(externalRunRef: string): Promise<void>;
}

export function createTriggerWorkflowDispatcher(
  sdk: TriggerSdkBoundary = createTriggerSdkBoundary(),
): TriggerWorkflowDispatcher {
  return Object.freeze({
    async startFeature(runId: string, projectId: string) {
      const result = await sdk.triggerTask(
        FEATURE_WORKFLOW_TASK_ID,
        { version: 'feature-task-payload-v1', runId },
        {
          idempotencyKey: `feature-workflow:${runId}:v1`,
          idempotencyKeyTTL: '30d',
          queue: featureWorkflowQueueName(projectId),
        },
      );
      return { externalRunRef: result.id };
    },
    async startGoal(runId: string, projectId: string) {
      const result = await sdk.triggerTask(
        GOAL_WORKFLOW_TASK_ID,
        { version: 'goal-task-payload-v1', runId },
        {
          idempotencyKey: `goal-workflow:${runId}:v1`,
          idempotencyKeyTTL: '30d',
          queue: goalWorkflowQueueName(projectId),
        },
      );
      return { externalRunRef: result.id };
    },
    async cancel(externalRunRef: string) {
      await sdk.cancelRun(externalRunRef);
    },
  });
}

export interface TriggerApprovalWaiter extends WorkflowApprovalWaiter {
  wake(id: string): Promise<void>;
}

export function createTriggerApprovalWaiter(
  sdk: TriggerSdkBoundary = createTriggerSdkBoundary(),
): TriggerApprovalWaiter {
  const waiter: TriggerApprovalWaiter = {
    async create(request) {
      return sdk.createWaitpoint({
        ...request,
        idempotencyKeyTTL: '30d',
      });
    },
    async wait(id) {
      const result = await sdk.waitForToken(id);
      return result.ok
        ? { status: 'completed' as const }
        : { status: 'timed_out' as const };
    },
    async wake(id) {
      // Wake-only payload. The resumed task must read the authoritative domain event.
      const result = await sdk.completeWaitpoint(id, { wake: true });
      if (!result.success)
        throw new Error('Trigger waitpoint could not be completed');
    },
  };
  return Object.freeze(waiter);
}
