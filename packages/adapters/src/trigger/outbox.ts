import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  isoTimestamp,
  persistenceId,
  type DomainRepository,
  type JsonValue,
  type RuntimeFileResource,
  type RuntimeHandle,
  type RuntimeProvider,
  type RuntimeStartRequest,
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

export const RUNTIME_START_VISIBILITY_DELAY_MS = 30_000;

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
  readonly runtimeStartRecovery?: {
    resolve(input: {
      readonly runId: string;
      readonly effectKey: string;
    }): Promise<{
      readonly request: RuntimeStartRequest;
      readonly aadForExternalId: (externalId: string) => JsonValue;
      readonly role: import('./types.js').FeatureRole;
      readonly stepRunId: string;
      readonly stepKey: string;
      readonly resources: readonly RuntimeFileResource[];
      readonly credentialRefs: readonly string[];
      readonly model: string;
      readonly pricingVersion: string;
      readonly priceUsage: (usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cacheReadInputTokens?: number;
        readonly cacheCreation5mInputTokens?: number;
        readonly cacheCreation1hInputTokens?: number;
        readonly runtimeMs: number;
      }) => number;
    }>;
  };
}

export interface DurableTriggerOutbox {
  requestStart(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
    readonly pipeline: 'feature' | 'goal';
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
  const pipeline = (request as { readonly pipeline?: 'feature' | 'goal' })
    .pipeline;
  // Preserve the pre-goal feature fingerprint so deployed feature intents can
  // replay across the schema upgrade. Goal intents remain explicitly bound.
  const fingerprintInput =
    pipeline === 'feature'
      ? { runId: request.runId, idempotencyKey: request.idempotencyKey }
      : request;
  return {
    key: request.idempotencyKey,
    runId: request.runId,
    kind,
    inputFingerprint: fingerprint(fingerprintInput),
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

async function recoverRuntimeStart(
  options: DurableTriggerOutboxOptions,
  input: { readonly runId: string; readonly effect: WorkflowEffect },
): Promise<
  | {
      readonly status: 'found';
      readonly handle: RuntimeHandle;
      readonly recovery: Awaited<
        ReturnType<
          NonNullable<
            DurableTriggerOutboxOptions['runtimeStartRecovery']
          >['resolve']
        >
      >;
    }
  | {
      readonly status: 'absent';
      readonly recovery: Awaited<
        ReturnType<
          NonNullable<
            DurableTriggerOutboxOptions['runtimeStartRecovery']
          >['resolve']
        >
      >;
    }
> {
  if (
    options.runtime === undefined ||
    options.runtimeHandles === undefined ||
    options.runtimeStartRecovery === undefined ||
    options.runtime.reconcileStart === undefined
  )
    throw new Error('runtime start recovery is not configured');
  const recovery = await options.runtimeStartRecovery.resolve({
    runId: input.runId,
    effectKey: input.effect.key,
  });
  const handle = await options.runtime.reconcileStart(recovery.request);
  if (handle === undefined) return { status: 'absent', recovery };
  await options.runtimeHandles.store({
    handle,
    runId: input.runId,
    stepRunId: recovery.stepRunId,
    role: recovery.role,
    aad: recovery.aadForExternalId(handle.id),
    at: options.clock(),
  });
  return { status: 'found', handle, recovery };
}

function effectOutput(
  effect: WorkflowEffect,
): { readonly [key: string]: JsonValue } | undefined {
  const output = effect.output;
  return typeof output === 'object' && output !== null && !Array.isArray(output)
    ? (output as { readonly [key: string]: JsonValue })
    : undefined;
}

function cleanupExternalReference(effect: WorkflowEffect): string | undefined {
  if (effect.kind === 'runtime-session') return effect.externalRef;
  const output = effectOutput(effect);
  if (
    (effect.kind === 'runtime-session-cancel' ||
      effect.kind === 'runtime-session-orphan-reconcile') &&
    effect.status === 'succeeded' &&
    typeof output === 'object' &&
    output !== null &&
    !Array.isArray(output) &&
    typeof output.externalRef === 'string'
  )
    return output.externalRef;
  return undefined;
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
      if (options.repository === undefined)
        throw new Error('repository is required before workflow dispatch');
      const run = await options.repository.getRun(
        persistenceId('run', request.runId),
      );
      if (run === undefined) throw new Error('workflow run not found');
      // Trigger task idempotency makes retry after an ambiguous response safe.
      const result = await (request.pipeline === 'goal'
        ? options.trigger.startGoal(request.runId, run.projectId)
        : options.trigger.startFeature(request.runId, run.projectId));
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
          runtimeEffect.status === 'started',
      );
      const failures: Error[] = [];
      for (const runtimeEffect of activeRuntimeEffects) {
        let externalRef = runtimeEffect.externalRef;
        let recoveredHandle: RuntimeHandle | undefined;
        if (externalRef === undefined) {
          const completedCancellation = effects.find((candidate) => {
            const output = effectOutput(candidate);
            return (
              candidate.kind === 'runtime-session-cancel' &&
              candidate.status === 'succeeded' &&
              output?.runtimeEffectKey === runtimeEffect.key &&
              typeof output.externalRef === 'string'
            );
          });
          if (completedCancellation !== undefined) continue;
          try {
            const recovered = await recoverRuntimeStart(options, {
              runId: request.runId,
              effect: runtimeEffect,
            });
            if (recovered.status === 'absent')
              throw new Error('ambiguous runtime start is not visible yet');
            externalRef = recovered.handle.id;
            recoveredHandle = recovered.handle;
          } catch (error) {
            failures.push(
              error instanceof Error
                ? error
                : new Error('runtime start recovery failed'),
            );
            continue;
          }
        }
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
            const handle =
              recoveredHandle ??
              (await options.runtimeHandles.load(externalRef, request.runId));
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
              {
                externalRef,
                runtimeEffectKey: runtimeEffect.key,
                cancelled: true,
              },
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
      const externalRefs = [
        ...new Set(
          effects
            .map(cleanupExternalReference)
            .filter((value): value is string => value !== undefined),
        ),
      ];
      for (const externalRef of externalRefs) {
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
        const runtimeIntent = effects.find(
          (candidate) =>
            candidate.kind === 'runtime-session' &&
            candidate.key.includes(`:${reservation.stepKey}:`),
        );
        // Runtime reservations are released exclusively by orphan
        // reconciliation after remote cleanup or confirmed absence. Generic
        // terminal cleanup must never bypass that proof.
        if (runtimeIntent !== undefined) continue;
        await options.repository!.appendUsage({
          idempotencyId: persistenceId(
            'usage',
            `usage:reservation-reconcile:${reservation.reservationKey}`,
          ),
          runId: persistenceId('run', reservation.runId),
          model: 'conservative-reservation',
          pricingVersion: 'conservative-reservation-v1',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
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
          reservation.projectId,
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
            candidate.key.includes(`:${reservation.stepKey}:`),
        );
        if (runtimeEffect === undefined)
          throw new Error('expired reservation runtime intent is unavailable');
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
        const recovery =
          runtimeEffect.externalRef === undefined
            ? await recoverRuntimeStart(options, {
                runId: request.runId,
                effect: runtimeEffect,
              })
            : undefined;
        let externalRef = runtimeEffect.externalRef;
        let handle: RuntimeHandle | undefined;
        const recoveryBinding =
          recovery?.recovery ??
          (await options.runtimeStartRecovery?.resolve({
            runId: request.runId,
            effectKey: runtimeEffect.key,
          }));
        if (recoveryBinding === undefined)
          throw new Error('runtime start recovery binding is unavailable');
        if (recovery?.status === 'found') {
          handle = recovery.handle;
          externalRef = handle.id;
          const recoveredEffect = await options.checkpoints.claimEffect(
            {
              key: runtimeEffect.key,
              runId: runtimeEffect.runId,
              kind: runtimeEffect.kind,
              inputFingerprint: runtimeEffect.inputFingerprint,
              createdAt: runtimeEffect.createdAt,
              updatedAt: runtimeEffect.updatedAt,
            },
            {
              ownerId: `orphan-recovery:${runtimeEffect.key}`,
              now,
              leaseExpiresAt: new Date(
                Date.parse(now) + 2 * 60_000,
              ).toISOString(),
            },
          );
          if (
            recoveredEffect.ownerId !== `orphan-recovery:${runtimeEffect.key}`
          )
            throw new Error('runtime recovery effect is still fenced');
          await options.checkpoints.attachExternalRef(
            {
              key: recoveredEffect.key,
              ownerId: recoveredEffect.ownerId,
              leaseVersion: recoveredEffect.leaseVersion,
            },
            handle.id,
            now,
          );
        } else if (externalRef !== undefined) {
          handle = await options.runtimeHandles.load(
            externalRef,
            request.runId,
          );
        } else {
          const absenceRequest = {
            runId: request.runId,
            idempotencyKey: `${reconcileRequest.idempotencyKey}:absence-observed`,
          };
          const absence = await ownedClaim(
            options,
            absenceRequest,
            'runtime-session-start-absence',
          );
          if (absence.effect.status !== 'succeeded') {
            await options.checkpoints.markEffectStarted(
              absence.lease,
              options.clock(),
            );
            await options.checkpoints.completeEffect(
              absence.lease,
              { firstObservedAt: now, runtimeEffectKey: runtimeEffect.key },
              options.clock(),
            );
            throw new Error(
              'ambiguous runtime start absence requires independent reconciliation',
            );
          }
          const absenceOutput = absence.effect.output;
          const absenceRecord =
            typeof absenceOutput === 'object' &&
            absenceOutput !== null &&
            !Array.isArray(absenceOutput)
              ? (absenceOutput as Readonly<Record<string, JsonValue>>)
              : undefined;
          const firstObservedAt =
            typeof absenceRecord?.firstObservedAt === 'string'
              ? absenceRecord.firstObservedAt
              : undefined;
          if (
            firstObservedAt === undefined ||
            !Number.isFinite(Date.parse(firstObservedAt)) ||
            Date.parse(now) - Date.parse(firstObservedAt) <
              RUNTIME_START_VISIBILITY_DELAY_MS
          )
            throw new Error(
              'ambiguous runtime start absence is inside the provider visibility delay',
            );
        }
        let usage: import('@agentos/core').RuntimeUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
          runtimeMs: FEATURE_WORKFLOW_DEFAULTS.sessionTimeoutMs,
        };
        let microdollars = reservation.estimatedMicrodollars;
        let usageModel = 'conservative-orphan-reservation';
        if (handle !== undefined) {
          try {
            await options.runtime.cancel(
              handle,
              'runtime session lease expired',
            );
          } catch {
            // Cleanup below also interrupts active sessions.
          }
          try {
            usage = await options.runtime.usage(handle);
            microdollars = recoveryBinding.priceUsage(usage);
            if (!Number.isSafeInteger(microdollars) || microdollars < 0)
              throw new Error('recovered runtime price is invalid');
            usageModel = `${recoveryBinding.model}@${recoveryBinding.pricingVersion}`;
          } catch {
            microdollars = reservation.estimatedMicrodollars;
            usageModel = 'conservative-orphan-reservation';
          }
          await options.runtime.cleanup(handle);
          await options.runtimeHandles.markCancelled(
            handle.id,
            options.clock(),
          );
          await options.runtimeHandles.markCleaned(handle.id, options.clock());
        } else {
          if (
            options.runtime.cleanupAccess === undefined &&
            (recoveryBinding.resources.length > 0 ||
              recoveryBinding.credentialRefs.length > 0)
          )
            throw new Error(
              'runtime access cleanup is required before releasing the session fence',
            );
          await options.runtime.cleanupAccess?.({
            resources: recoveryBinding.resources,
            credentialRefs: recoveryBinding.credentialRefs,
          });
        }
        await options.repository.appendUsage({
          idempotencyId: persistenceId(
            'usage',
            `usage:orphan-reconcile:${reservation.reservationKey}`,
          ),
          runId: persistenceId('run', reservation.runId),
          model: usageModel,
          pricingVersion: recoveryBinding.pricingVersion,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens ?? 0,
          cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens ?? 0,
          runtimeMs: usage.runtimeMs,
          microdollars,
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
          actualMicrodollars: microdollars,
          workflowSpentMicrodollars: spent,
          dailySpentMicrodollars: spent,
          workflowLimitMicrodollars:
            FEATURE_WORKFLOW_DEFAULTS.workflowMicrodollars,
          dailyLimitMicrodollars: FEATURE_WORKFLOW_DEFAULTS.dailyMicrodollars,
          now,
        });
        await options.checkpoints.releaseSession(
          reservation.projectId,
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
            ...(externalRef === undefined ? {} : { externalRef }),
            settledMicrodollars: microdollars,
          },
          options.clock(),
        );
      }
    },
  };
  return Object.freeze(outbox);
}
