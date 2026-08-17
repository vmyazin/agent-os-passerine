import { createHash } from 'node:crypto';

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
  readonly sourceSnapshot?: {
    ensure(runId: string): Promise<{
      readonly key: string;
      readonly digest: string;
      readonly sizeBytes: number;
    }>;
  };
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
  requestOrphanReconciliation(request: {
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
  // A logical delivery keeps the same owner across process restarts. This lets
  // a retry reclaim its own ambiguous effect immediately while fencing other
  // idempotency keys until reconciliation.
  const ownerId = `outbox:${request.idempotencyKey}`;
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
      if (options.sourceSnapshot === undefined)
        throw new Error(
          'source snapshot ingestion is required before dispatch',
        );
      const sourceRequest = {
        ...request,
        idempotencyKey: `source:${request.runId}`,
      };
      const sourceClaim = await ownedClaim(
        options,
        sourceRequest,
        'source-snapshot-ingest',
      );
      if (sourceClaim.effect.status !== 'succeeded') {
        await options.checkpoints.markEffectStarted(
          sourceClaim.lease,
          options.clock(),
        );
        const source = await options.sourceSnapshot.ensure(request.runId);
        await options.checkpoints.attachExternalRef(
          sourceClaim.lease,
          source.key,
          options.clock(),
        );
        await options.checkpoints.completeEffect(
          sourceClaim.lease,
          {
            artifactKey: source.key,
            digest: source.digest,
            sizeBytes: source.sizeBytes,
          },
          options.clock(),
        );
      }
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
      const failures: Error[] = [];
      for (const runtimeEffect of activeRuntimeEffects) {
        const externalRef = runtimeEffect.externalRef!;
        const cancelRequest = {
          runId: request.runId,
          idempotencyKey: `${request.idempotencyKey}:runtime:${externalRef}`,
        };
        try {
          if (
            options.runtime === undefined ||
            options.runtimeHandles === undefined
          )
            throw new Error(
              'active runtime cancellation requires the trusted runtime provider',
            );
          const runtimeClaim = await ownedClaim(
            options,
            cancelRequest,
            'runtime-session-cancel',
          );
          if (runtimeClaim.effect.status !== 'succeeded') {
            await options.checkpoints.markEffectStarted(
              runtimeClaim.lease,
              options.clock(),
            );
            const handle = await options.runtimeHandles.load(
              externalRef,
              request.runId,
            );
            await options.runtime.cancel(
              handle,
              'authoritative run cancellation',
            );
            await options.runtimeHandles.markCancelled(
              externalRef,
              options.clock(),
            );
            await options.checkpoints.completeEffect(
              runtimeClaim.lease,
              { externalRef, cancelled: true },
              options.clock(),
            );
          }
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error('runtime cancel failed'),
          );
        }
      }
      const triggerStart = effects.find(
        (candidate) =>
          candidate.kind === 'trigger-workflow-start' &&
          candidate.externalRef !== undefined,
      );
      if (triggerStart?.externalRef !== undefined) {
        const triggerRequest = {
          runId: request.runId,
          idempotencyKey: `${request.idempotencyKey}:trigger`,
        };
        try {
          const triggerClaim = await ownedClaim(
            options,
            triggerRequest,
            'trigger-run-cancel',
          );
          if (triggerClaim.effect.status !== 'succeeded') {
            await options.checkpoints.markEffectStarted(
              triggerClaim.lease,
              options.clock(),
            );
            await options.trigger.cancel(triggerStart.externalRef);
            await options.checkpoints.completeEffect(
              triggerClaim.lease,
              { externalRunRef: triggerStart.externalRef, cancelled: true },
              options.clock(),
            );
          }
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error('Trigger cancel failed'),
          );
        }
      }
      if (failures.length > 0) throw failures[0];
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
    async requestOrphanReconciliation(request) {
      if (
        options.runtime === undefined ||
        options.runtimeHandles === undefined ||
        options.repository === undefined
      )
        throw new Error(
          'orphan reconciliation requires trusted runtime composition',
        );
      const now = options.clock();
      const expired = await options.checkpoints.listExpiredReservations(
        request.runId,
        now,
      );
      if (expired.length === 0) return;
      const effects = await options.checkpoints.listEffects(request.runId);
      for (const reservation of expired) {
        const runtimeEffect = effects.find(
          (candidate) =>
            candidate.kind === 'runtime-session' &&
            candidate.externalRef !== undefined &&
            candidate.key.includes(`:${reservation.stepKey}:`),
        );
        if (runtimeEffect?.externalRef === undefined)
          throw new Error('expired reservation runtime handle is unavailable');
        const reconcileRequest = {
          runId: request.runId,
          idempotencyKey: `${request.idempotencyKey}:${reservation.reservationKey}`,
        };
        const claim = await ownedClaim(
          options,
          reconcileRequest,
          'runtime-session-orphan-reconcile',
        );
        if (claim.effect.status === 'succeeded') continue;
        await options.checkpoints.markEffectStarted(
          claim.lease,
          options.clock(),
        );
        const handle = await options.runtimeHandles.load(
          runtimeEffect.externalRef,
          request.runId,
        );
        try {
          await options.runtime.cancel(handle, 'runtime session lease expired');
        } catch {
          // Cleanup below also interrupts active sessions and is the authoritative
          // confirmation that the paid session no longer runs.
        }
        let usage = {
          inputTokens: 0,
          outputTokens: 0,
          runtimeMs: FEATURE_WORKFLOW_DEFAULTS.sessionTimeoutMs,
        };
        try {
          usage = await options.runtime.usage(handle);
        } catch {
          // The full reservation is charged below when exact provider usage is
          // unavailable after a crash.
        }
        await options.runtime.cleanup(handle);
        await options.runtimeHandles.markCancelled(
          runtimeEffect.externalRef,
          options.clock(),
        );
        await options.runtimeHandles.markCleaned(
          runtimeEffect.externalRef,
          options.clock(),
        );
        await options.repository.appendUsage({
          idempotencyId: persistenceId(
            'usage',
            `usage:orphan-reconcile:${reservation.reservationKey}`,
          ),
          runId: persistenceId('run', reservation.runId),
          model: 'conservative-orphan-reservation',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          runtimeMs: usage.runtimeMs,
          microdollars: reservation.estimatedMicrodollars,
          recordedAt: isoTimestamp(now),
        });
        const spent = (
          await options.repository.listUsage(
            persistenceId('run', reservation.runId),
            { limit: 1_000 },
          )
        ).reduce((sum, record) => sum + record.microdollars, 0);
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
        const run = await options.repository.getRun(
          persistenceId('run', request.runId),
        );
        if (
          run !== undefined &&
          ['pending', 'running', 'waiting'].includes(run.status)
        ) {
          await options.repository.transitionRun(
            run.id,
            ['pending', 'running', 'waiting'],
            {
              status: 'failed',
              error: { code: 'orphaned_runtime_session' },
              output: {
                status: 'failed',
                reason: 'orphaned_runtime_session',
              },
              updatedAt: isoTimestamp(now),
              completedAt: isoTimestamp(now),
            },
            run.stateVersion ?? 0,
          );
        }
        await options.checkpoints.completeEffect(
          claim.lease,
          {
            externalRef: runtimeEffect.externalRef,
            settledMicrodollars: reservation.estimatedMicrodollars,
          },
          options.clock(),
        );
      }
    },
  };
  return Object.freeze(outbox);
}
