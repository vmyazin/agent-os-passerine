import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalJsonValue,
  isoTimestamp,
  persistenceId,
  type DomainRepository,
  type RuntimeProvider,
} from '@agentos/core';

import {
  FEATURE_WORKFLOW_DEFAULTS,
  type RuntimeHandleVault,
  type WorkflowCheckpointStore,
  type WorkflowEffect,
} from './types.js';
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
  readonly runtimeHandles?: RuntimeHandleVault;
  readonly repository?: DomainRepository;
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
  requestCleanup(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
  }): Promise<void>;
}

function draft(
  request: { readonly runId: string; readonly idempotencyKey: string },
  kind: string,
  now: string,
): Omit<
  WorkflowEffect,
  'status' | 'ownerId' | 'leaseVersion' | 'leaseExpiresAt'
> {
  return {
    key: request.idempotencyKey,
    runId: request.runId,
    kind,
    inputFingerprint: fingerprint(request),
    createdAt: now,
    updatedAt: now,
  };
}

async function ownedClaim(
  options: DurableTriggerOutboxOptions,
  request: { readonly runId: string; readonly idempotencyKey: string },
  kind: string,
) {
  const ownerId = `outbox:${randomUUID()}`;
  const now = options.clock();
  const effect = await options.checkpoints.claimEffect(
    draft(request, kind, now),
    {
      ownerId,
      now,
      leaseExpiresAt: new Date(Date.parse(now) + 2 * 60_000).toISOString(),
    },
  );
  if (effect.status === 'succeeded') {
    return {
      effect,
      lease: {
        key: effect.key,
        ownerId: effect.ownerId ?? ownerId,
        leaseVersion: effect.leaseVersion,
      },
    };
  }
  if (effect.ownerId !== ownerId)
    throw new Error('workflow outbox effect is owned by another delivery');
  return {
    effect,
    lease: { key: effect.key, ownerId, leaseVersion: effect.leaseVersion },
  };
}

export function createDurableTriggerOutbox(
  options: DurableTriggerOutboxOptions,
): DurableTriggerOutbox {
  const outbox: DurableTriggerOutbox = {
    async requestStart(request) {
      const claim = await ownedClaim(
        options,
        request,
        'trigger-workflow-start',
      );
      const effect = claim.effect;
      if (effect.status === 'succeeded') return;
      await options.checkpoints.markEffectStarted(claim.lease, options.clock());
      // Trigger task idempotency makes retry after an ambiguous response safe.
      const result = await options.trigger.startFeature(request.runId);
      await options.checkpoints.attachExternalRef(
        claim.lease,
        result.externalRunRef,
        options.clock(),
      );
      await options.checkpoints.completeEffect(
        claim.lease,
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
      const claim = await ownedClaim(
        options,
        request,
        'trigger-approval-resume',
      );
      const effect = claim.effect;
      if (effect.status === 'succeeded') return;
      await options.checkpoints.markEffectStarted(claim.lease, options.clock());
      // The payload is wake-only; decision and scope are re-read from Postgres.
      await options.approval.wake(waitpoint.externalRef);
      await options.checkpoints.completeEffect(
        claim.lease,
        { waitpointRef: waitpoint.externalRef },
        options.clock(),
      );
    },
    async requestCancel(request) {
      const claim = await ownedClaim(
        options,
        request,
        'trigger-workflow-cancel',
      );
      const effect = claim.effect;
      if (effect.status === 'succeeded') return;
      await options.checkpoints.markEffectStarted(claim.lease, options.clock());
      const effects = await options.checkpoints.listEffects(request.runId);
      const activeRuntimeEffects = effects.filter(
        (runtimeEffect) =>
          runtimeEffect.kind === 'runtime-session' &&
          runtimeEffect.status === 'started' &&
          runtimeEffect.externalRef !== undefined,
      );
      if (
        activeRuntimeEffects.length > 0 &&
        (options.runtime === undefined || options.runtimeHandles === undefined)
      ) {
        throw new Error(
          'active runtime cancellation requires the trusted runtime provider',
        );
      }
      if (options.runtime !== undefined) {
        for (const runtimeEffect of activeRuntimeEffects) {
          if (runtimeEffect.externalRef !== undefined) {
            const handle = await options.runtimeHandles!.load(
              runtimeEffect.externalRef,
              request.runId,
            );
            await options.runtime.cancel(
              handle,
              'authoritative run cancellation',
            );
            await options.runtimeHandles!.markCancelled(
              runtimeEffect.externalRef,
              options.clock(),
            );
            await options.runtime.cleanup(handle);
            await options.runtimeHandles!.markCleaned(
              runtimeEffect.externalRef,
              options.clock(),
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
        claim.lease,
        { cancelled: true },
        options.clock(),
      );
    },
    async requestCleanup(request) {
      if (options.runtime === undefined || options.runtimeHandles === undefined)
        throw new Error('runtime cleanup requires trusted runtime composition');
      const effects = await options.checkpoints.listEffects(request.runId);
      for (const runtimeEffect of effects.filter(
        (candidate) =>
          candidate.kind === 'runtime-session' &&
          candidate.externalRef !== undefined,
      )) {
        const externalRef = runtimeEffect.externalRef!;
        const cleanupRequest = {
          ...request,
          idempotencyKey: `${request.idempotencyKey}:${externalRef}`,
        };
        const claim = await ownedClaim(
          options,
          cleanupRequest,
          'runtime-session-cleanup',
        );
        if (claim.effect.status === 'succeeded') continue;
        await options.checkpoints.markEffectStarted(
          claim.lease,
          options.clock(),
        );
        const handle = await options.runtimeHandles.load(
          externalRef,
          request.runId,
        );
        await options.runtime.cleanup(handle);
        await options.runtimeHandles.markCleaned(externalRef, options.clock());
        await options.checkpoints.completeEffect(
          claim.lease,
          { externalRef, cleaned: true },
          options.clock(),
        );
      }
      const now = options.clock();
      const expired = await options.checkpoints.listExpiredReservations(
        request.runId,
        now,
      );
      if (expired.length > 0 && options.repository === undefined)
        throw new Error(
          'expired budget reconciliation requires the domain repository',
        );
      for (const reservation of expired) {
        await options.repository!.appendUsage({
          idempotencyId: persistenceId(
            'usage',
            `usage:reservation-reconcile:${reservation.reservationKey}`,
          ),
          runId: persistenceId('run', reservation.runId),
          model: 'conservative-reservation',
          inputTokens: 0,
          outputTokens: 0,
          runtimeMs: 20 * 60_000,
          microdollars: reservation.estimatedMicrodollars,
          recordedAt: isoTimestamp(now),
        });
        const spent = (
          await options.repository!.listUsage(
            persistenceId('run', reservation.runId),
            { limit: 1_000 },
          )
        ).reduce((sum, usage) => sum + usage.microdollars, 0);
        await options.checkpoints.settleSession({
          reservationKey: reservation.reservationKey,
          runId: reservation.runId,
          stepKey: reservation.stepKey,
          actualMicrodollars: reservation.estimatedMicrodollars,
          workflowSpentMicrodollars: spent,
          dailySpentMicrodollars: spent,
          workflowLimitMicrodollars:
            FEATURE_WORKFLOW_DEFAULTS.workflowMicrodollars,
          dailyLimitMicrodollars: FEATURE_WORKFLOW_DEFAULTS.dailyMicrodollars,
          now,
        });
        await options.checkpoints.releaseSession(
          reservation.runId,
          reservation.stepKey,
        );
      }
    },
  };
  return Object.freeze(outbox);
}
