import { describe, expect, it } from 'vitest';

import {
  createTriggerApprovalWaiter,
  createTriggerWorkflowDispatcher,
  type TriggerSdkBoundary,
} from './trigger-adapter.js';

function fakeSdk() {
  const calls: { method: string; args: unknown[] }[] = [];
  const sdk: TriggerSdkBoundary = {
    async triggerTask(...args) {
      calls.push({ method: 'triggerTask', args });
      return { id: 'trigger-run-safe-ref' };
    },
    async createWaitpoint(...args) {
      calls.push({ method: 'createWaitpoint', args });
      return { id: 'waitpoint-safe-ref' };
    },
    async waitForToken(...args) {
      calls.push({ method: 'waitForToken', args });
      return { ok: true };
    },
    async completeWaitpoint(...args) {
      calls.push({ method: 'completeWaitpoint', args });
      return { success: true };
    },
    async cancelRun(...args) {
      calls.push({ method: 'cancelRun', args });
    },
  };
  return { sdk, calls };
}

describe('Trigger SDK boundary', () => {
  it('starts the versioned task with a stable global idempotency key', async () => {
    const { sdk, calls } = fakeSdk();
    const dispatcher = createTriggerWorkflowDispatcher(sdk);
    await expect(dispatcher.startFeature('run-1')).resolves.toEqual({
      externalRunRef: 'trigger-run-safe-ref',
    });
    expect(calls).toEqual([
      {
        method: 'triggerTask',
        args: [
          'agentos-feature-workflow-v1',
          { version: 'feature-task-payload-v1', runId: 'run-1' },
          expect.objectContaining({
            idempotencyKey: 'feature-workflow:run-1:v1',
            idempotencyKeyTTL: '30d',
          }),
        ],
      },
    ]);
  });

  it('starts the separately versioned goal task with a pipeline-bound key', async () => {
    const { sdk, calls } = fakeSdk();
    const dispatcher = createTriggerWorkflowDispatcher(sdk);

    await expect(dispatcher.startGoal('goal-1')).resolves.toEqual({
      externalRunRef: 'trigger-run-safe-ref',
    });
    expect(calls).toEqual([
      {
        method: 'triggerTask',
        args: [
          'agentos-goal-workflow-v1',
          { version: 'goal-task-payload-v1', runId: 'goal-1' },
          expect.objectContaining({
            idempotencyKey: 'goal-workflow:goal-1:v1',
            idempotencyKeyTTL: '30d',
          }),
        ],
      },
    ]);
  });

  it('uses waitpoints only as wake signals and never returns public tokens', async () => {
    const { sdk, calls } = fakeSdk();
    const waiter = createTriggerApprovalWaiter(sdk);
    await expect(
      waiter.create({
        idempotencyKey: 'wait-key',
        timeout: '3600s',
        tags: ['run:run-1'],
      }),
    ).resolves.toEqual({ id: 'waitpoint-safe-ref' });
    await expect(waiter.wait('waitpoint-safe-ref')).resolves.toEqual({
      status: 'completed',
    });
    await waiter.wake('waitpoint-safe-ref');
    expect(calls[0]).toEqual({
      method: 'createWaitpoint',
      args: [expect.objectContaining({ timeout: '3600s' })],
    });
    expect(JSON.stringify(calls)).not.toMatch(
      /approved|rejected|publicAccessToken|callback/i,
    );
  });
});
