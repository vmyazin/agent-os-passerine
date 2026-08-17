import { createHash } from 'node:crypto';

import { canonicalJsonValue, type RuntimeProvider } from '@agentos/core';

import type { WorkflowCheckpointStore, WorkflowEffect } from './types.js';
import type {
  TriggerApprovalWaiter,
  TriggerWorkflowDispatcher,
} from './trigger-adapter.js';

const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(canonicalJsonValue(JSON.parse(JSON.stringify(value))))
    .digest('hex');

export interface DurableTriggerOutboxOptions {
  readonly checkpoints: WorkflowCheckpointStore;
  readonly trigger: TriggerWorkflowDispatcher;
  readonly approval: TriggerApprovalWaiter;
  readonly clock: () => string;
  readonly runtime?: RuntimeProvider;
}

export interface DurableTriggerOutbox {
  requestStart(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
  }): Promise<void>;
  requestApprovalResume(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
    readonly approvalId: string;
    readonly decision: 'approve' | 'reject';
    readonly scopeHash: string;
  }): Promise<void>;
  requestCancel(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
  }): Promise<void>;
}

function draft(
  request: { readonly runId: string; readonly idempotencyKey: string },
  kind: string,
  now: string,
): Omit<WorkflowEffect, 'status'> {
  return {
    key: request.idempotencyKey,
    runId: request.runId,
    kind,
    inputFingerprint: fingerprint(request),
    createdAt: now,
    updatedAt: now,
  };
}

export function createDurableTriggerOutbox(
  options: DurableTriggerOutboxOptions,
): DurableTriggerOutbox {
  const outbox: DurableTriggerOutbox = {
    async requestStart(request) {
      const effect = await options.checkpoints.claimEffect(
        draft(request, 'trigger-workflow-start', options.clock()),
      );
      if (effect.status === 'succeeded') return;
      await options.checkpoints.markEffectStarted(effect.key, options.clock());
      // Trigger task idempotency makes retry after an ambiguous response safe.
      const result = await options.trigger.startFeature(request.runId);
      await options.checkpoints.attachExternalRef(
        effect.key,
        result.externalRunRef,
        options.clock(),
      );
      await options.checkpoints.completeEffect(
        effect.key,
        { externalRunRef: result.externalRunRef },
        options.clock(),
      );
    },
    async requestApprovalResume(request) {
      const waitpoint = await options.checkpoints.getEffect(
        `waitpoint:${request.runId}:${request.approvalId}`,
      );
      if (waitpoint?.externalRef === undefined)
        throw new Error(
          'approval waitpoint has no persisted Trigger reference',
        );
      const effect = await options.checkpoints.claimEffect(
        draft(request, 'trigger-approval-resume', options.clock()),
      );
      if (effect.status === 'succeeded') return;
      await options.checkpoints.markEffectStarted(effect.key, options.clock());
      // The payload is wake-only; decision and scope are re-read from Postgres.
      await options.approval.wake(waitpoint.externalRef);
      await options.checkpoints.completeEffect(
        effect.key,
        { waitpointRef: waitpoint.externalRef },
        options.clock(),
      );
    },
    async requestCancel(request) {
      const effect = await options.checkpoints.claimEffect(
        draft(request, 'trigger-workflow-cancel', options.clock()),
      );
      if (effect.status === 'succeeded') return;
      await options.checkpoints.markEffectStarted(effect.key, options.clock());
      const effects = await options.checkpoints.listEffects(request.runId);
      const activeRuntimeEffects = effects.filter(
        (runtimeEffect) =>
          runtimeEffect.kind === 'runtime-session' &&
          runtimeEffect.status === 'started' &&
          runtimeEffect.externalRef !== undefined,
      );
      if (activeRuntimeEffects.length > 0 && options.runtime === undefined) {
        throw new Error(
          'active runtime cancellation requires the trusted runtime provider',
        );
      }
      if (options.runtime !== undefined) {
        for (const runtimeEffect of activeRuntimeEffects) {
          if (runtimeEffect.externalRef !== undefined) {
            await options.runtime.cancel(
              { id: runtimeEffect.externalRef },
              'authoritative run cancellation',
            );
          }
        }
      }
      const triggerStart = effects.find(
        (candidate) =>
          candidate.kind === 'trigger-workflow-start' &&
          candidate.externalRef !== undefined,
      );
      if (triggerStart?.externalRef !== undefined)
        await options.trigger.cancel(triggerStart.externalRef);
      await options.checkpoints.completeEffect(
        effect.key,
        { cancelled: true },
        options.clock(),
      );
    },
  };
  return Object.freeze(outbox);
}
