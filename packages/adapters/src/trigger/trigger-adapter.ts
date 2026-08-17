import { runs, tasks, wait } from '@trigger.dev/sdk';

import {
  FEATURE_WORKFLOW_TASK_ID,
  type WorkflowApprovalWaiter,
} from './types.js';

export interface TriggerTaskOptions {
  readonly idempotencyKey: string;
  readonly idempotencyKeyTTL: string;
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
  };
  return Object.freeze(boundary);
}

export interface TriggerWorkflowDispatcher {
  startFeature(runId: string): Promise<{ readonly externalRunRef: string }>;
  cancel(externalRunRef: string): Promise<void>;
}

export function createTriggerWorkflowDispatcher(
  sdk: TriggerSdkBoundary = createTriggerSdkBoundary(),
): TriggerWorkflowDispatcher {
  return Object.freeze({
    async startFeature(runId: string) {
      const result = await sdk.triggerTask(
        FEATURE_WORKFLOW_TASK_ID,
        { version: 'feature-task-payload-v1', runId },
        {
          idempotencyKey: `feature-workflow:${runId}:v1`,
          idempotencyKeyTTL: '30d',
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
