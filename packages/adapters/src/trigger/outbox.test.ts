import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  isoTimestamp,
  persistenceId,
  type DomainRepository,
  type RuntimeProvider,
} from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { InMemoryWorkflowCheckpointStore } from './checkpoint-store.js';
import { createDurableTriggerOutbox } from './outbox.js';

const now = '2026-08-17T12:00:00.000Z';

function repositoryWithRun(runId: string, projectId = 'project-1') {
  const id = persistenceId('run', runId);
  const scopedProjectId = persistenceId('project', projectId);
  return {
    getRun: vi.fn(async (requestedId: string) =>
      requestedId === id
        ? ({ id, projectId: scopedProjectId } as Awaited<
            ReturnType<DomainRepository['getRun']>
          >)
        : undefined,
    ),
  } as unknown as DomainRepository;
}

async function startedEffect(
  store: InMemoryWorkflowCheckpointStore,
  input: { key: string; kind: string; externalRef?: string },
) {
  const effect = await store.claimEffect(
    {
      key: input.key,
      runId: 'run-1',
      kind: input.kind,
      inputFingerprint: 'a'.repeat(64),
      createdAt: now,
      updatedAt: now,
    },
    {
      ownerId: 'seed-owner',
      now,
      leaseExpiresAt: '2026-08-17T12:05:00.000Z',
    },
  );
  const lease = {
    key: effect.key,
    ownerId: 'seed-owner',
    leaseVersion: effect.leaseVersion,
  };
  await store.markEffectStarted(lease, now);
  if (input.externalRef !== undefined)
    await store.attachExternalRef(lease, input.externalRef, now);
}

function collaborators(
  runtime?: RuntimeProvider,
  repository?: DomainRepository,
  clock: () => string = () => now,
) {
  const checkpoints = new InMemoryWorkflowCheckpointStore();
  const cancelTrigger = vi.fn(async () => undefined);
  return {
    checkpoints,
    cancelTrigger,
    outbox: createDurableTriggerOutbox({
      checkpoints,
      trigger: {
        startFeature: vi.fn(),
        startGoal: vi.fn(),
        cancel: cancelTrigger,
      },
      approval: {
        create: vi.fn(),
        wait: vi.fn(),
        wake: vi.fn(),
      },
      clock,
      sourceSnapshot: {
        ensure: vi.fn(async () => ({
          key: 'source/bundle',
          digest: 'b'.repeat(64),
          sizeBytes: 123,
        })),
      },
      ...(runtime === undefined ? {} : { runtime }),
      ...(repository === undefined ? {} : { repository }),
      ...(runtime === undefined
        ? {}
        : {
            runtimeHandles: {
              store: vi.fn(async () => undefined),
              load: async (externalId: string) => ({
                id: externalId,
                ownershipCapability: 'sealed-capability',
              }),
              markCancelled: vi.fn(async () => undefined),
              markCleaned: vi.fn(async () => undefined),
            },
            runtimeStartRecovery: {
              resolve: vi.fn(async ({ effectKey }: { effectKey: string }) => ({
                request: {
                  runId: 'run-1',
                  stepId: 'implementation',
                  agentId: 'implementer',
                  environmentId: 'implementation',
                  input: {},
                  idempotencyKey: effectKey,
                },
                aadForExternalId: (externalId: string) => ({ externalId }),
                role: 'implementation' as const,
                stepRunId: 'implementation',
                stepKey: 'implementation',
                resources: [],
                credentialRefs: [],
                model: 'sonnet',
                pricingVersion: 'pricing-v1',
                priceUsage: () => 123_456,
              })),
            },
          }),
    }),
  };
}

describe('durable Trigger outbox start', () => {
  it('replays feature starts created before pipeline-bound fingerprints', async () => {
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    const startFeature = vi.fn();
    const legacyRequest = {
      idempotencyKey: 'workflow-start:legacy-feature',
      runId: 'legacy-feature',
    };
    for (const [key, kind, externalRef] of [
      ['source:legacy-feature', 'source-snapshot-ingest', 'source/legacy'],
      [
        legacyRequest.idempotencyKey,
        'trigger-workflow-start',
        'trigger-legacy',
      ],
    ] as const) {
      const request =
        kind === 'source-snapshot-ingest'
          ? { ...legacyRequest, idempotencyKey: key }
          : legacyRequest;
      const ownerId = `outbox:${request.idempotencyKey}`;
      const effect = await checkpoints.claimEffect(
        {
          key,
          runId: request.runId,
          kind,
          inputFingerprint: createHash('sha256')
            .update(canonicalJsonValue(request))
            .digest('hex'),
          createdAt: now,
          updatedAt: now,
        },
        {
          ownerId,
          now,
          leaseExpiresAt: '2026-08-17T12:05:00.000Z',
        },
      );
      const lease = { key, ownerId, leaseVersion: effect.leaseVersion };
      await checkpoints.markEffectStarted(lease, now);
      await checkpoints.attachExternalRef(lease, externalRef, now);
      await checkpoints.completeEffect(lease, { externalRef }, now);
    }
    const outbox = createDurableTriggerOutbox({
      checkpoints,
      trigger: { startFeature, startGoal: vi.fn(), cancel: vi.fn() },
      approval: { create: vi.fn(), wait: vi.fn(), wake: vi.fn() },
      sourceSnapshot: { ensure: vi.fn() },
      clock: () => now,
    });

    await expect(
      outbox.requestStart({ ...legacyRequest, pipeline: 'feature' }),
    ).resolves.toBeUndefined();
    expect(startFeature).not.toHaveBeenCalled();
  });

  it('ingests the SHA-bound source before one idempotent Trigger start', async () => {
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    const calls: string[] = [];
    const ensure = vi.fn(async () => {
      calls.push('source');
      return {
        key: 'source/bundle-v1',
        digest: 'b'.repeat(64),
        sizeBytes: 123,
      };
    });
    const startFeature = vi.fn(async () => {
      calls.push('trigger');
      return { externalRunRef: 'trigger-run-1' };
    });
    const outbox = createDurableTriggerOutbox({
      checkpoints,
      trigger: { startFeature, startGoal: vi.fn(), cancel: vi.fn() },
      approval: { create: vi.fn(), wait: vi.fn(), wake: vi.fn() },
      sourceSnapshot: { ensure },
      repository: repositoryWithRun('run-1'),
      clock: () => now,
    });
    const request = {
      idempotencyKey: 'workflow-start:run-1',
      runId: 'run-1',
      pipeline: 'feature' as const,
    };

    await outbox.requestStart(request);
    await outbox.requestStart(request);

    expect(calls).toEqual(['source', 'trigger']);
    await expect(checkpoints.getEffect('source:run-1')).resolves.toMatchObject({
      status: 'succeeded',
      externalRef: 'source/bundle-v1',
    });
    await expect(
      checkpoints.getEffect('workflow-start:run-1'),
    ).resolves.toMatchObject({
      status: 'succeeded',
      externalRef: 'trigger-run-1',
    });
  });

  it('dispatches a goal start only to the goal task and binds the pipeline fingerprint', async () => {
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    const startFeature = vi.fn();
    const startGoal = vi.fn(async () => ({
      externalRunRef: 'trigger-goal-1',
    }));
    const outbox = createDurableTriggerOutbox({
      checkpoints,
      trigger: {
        startFeature,
        startGoal,
        cancel: vi.fn(),
      },
      approval: { create: vi.fn(), wait: vi.fn(), wake: vi.fn() },
      sourceSnapshot: {
        ensure: vi.fn(async () => ({
          key: 'source/goal-bundle-v1',
          digest: 'b'.repeat(64),
          sizeBytes: 123,
        })),
      },
      repository: repositoryWithRun('goal-1', 'goal-project'),
      clock: () => now,
    });
    const request = {
      idempotencyKey: 'workflow-start:goal-1',
      runId: 'goal-1',
      pipeline: 'goal' as const,
    };

    await outbox.requestStart(request);

    expect(startGoal).toHaveBeenCalledWith('goal-1', 'goal-project');
    expect(startFeature).not.toHaveBeenCalled();
    await expect(
      outbox.requestStart({ ...request, pipeline: 'feature' }),
    ).rejects.toThrow(/different|fingerprint|conflict/i);
  });

  it('reconciles crashes after both source write and remote Trigger creation', async () => {
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    let sourceAttempts = 0;
    const ensure = vi.fn(async () => {
      sourceAttempts += 1;
      if (sourceAttempts === 1)
        throw new Error('response lost after content-addressed source write');
      return {
        key: 'source/bundle-v1',
        digest: 'b'.repeat(64),
        sizeBytes: 123,
      };
    });
    let triggerAttempts = 0;
    const startFeature = vi.fn(async () => {
      triggerAttempts += 1;
      if (triggerAttempts === 1)
        throw new Error('response lost after idempotent Trigger creation');
      return { externalRunRef: 'trigger-run-1' };
    });
    const outbox = createDurableTriggerOutbox({
      checkpoints,
      trigger: { startFeature, startGoal: vi.fn(), cancel: vi.fn() },
      approval: { create: vi.fn(), wait: vi.fn(), wake: vi.fn() },
      sourceSnapshot: { ensure },
      repository: repositoryWithRun('run-1'),
      clock: () => now,
    });
    const request = {
      idempotencyKey: 'workflow-start:run-1',
      runId: 'run-1',
      pipeline: 'feature' as const,
    };

    await expect(outbox.requestStart(request)).rejects.toThrow('source write');
    await expect(outbox.requestStart(request)).rejects.toThrow(
      'Trigger creation',
    );
    await expect(outbox.requestStart(request)).resolves.toBeUndefined();
    await expect(outbox.requestStart(request)).resolves.toBeUndefined();

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(startFeature).toHaveBeenCalledTimes(2);
    await expect(
      checkpoints.getEffect('workflow-start:run-1'),
    ).resolves.toMatchObject({
      status: 'succeeded',
      externalRef: 'trigger-run-1',
    });
  });
});

describe('durable Trigger outbox cancellation', () => {
  it('still cancels Trigger when an active runtime cannot be cancelled safely', async () => {
    const { checkpoints, cancelTrigger, outbox } = collaborators();
    await startedEffect(checkpoints, {
      key: 'trigger:run-1',
      kind: 'trigger-workflow-start',
      externalRef: 'trigger-run-1',
    });
    await startedEffect(checkpoints, {
      key: 'runtime:run-1:implementation:1',
      kind: 'runtime-session',
      externalRef: 'runtime-session-1',
    });

    await expect(
      outbox.requestCancel({ idempotencyKey: 'cancel:run-1', runId: 'run-1' }),
    ).rejects.toThrow('trusted runtime provider');

    expect(cancelTrigger).toHaveBeenCalledOnce();
    await expect(checkpoints.getEffect('cancel:run-1')).resolves.toMatchObject({
      status: 'started',
    });
  });

  it('cancels the active runtime before Trigger and replays without duplicates', async () => {
    const calls: string[] = [];
    const runtime = {
      cancel: vi.fn(async () => {
        calls.push('runtime');
      }),
      cleanup: vi.fn(async () => undefined),
    } as unknown as RuntimeProvider;
    const { checkpoints, cancelTrigger, outbox } = collaborators(runtime);
    cancelTrigger.mockImplementation(async () => {
      calls.push('trigger');
    });
    await startedEffect(checkpoints, {
      key: 'trigger:run-1',
      kind: 'trigger-workflow-start',
      externalRef: 'trigger-run-1',
    });
    await startedEffect(checkpoints, {
      key: 'runtime:run-1:implementation:1',
      kind: 'runtime-session',
      externalRef: 'runtime-session-1',
    });
    const request = { idempotencyKey: 'cancel:run-1', runId: 'run-1' };

    await outbox.requestCancel(request);
    await outbox.requestCancel(request);

    expect(calls).toEqual(['runtime', 'trigger']);
    expect(runtime.cancel).toHaveBeenCalledWith(
      {
        id: 'runtime-session-1',
        ownershipCapability: 'sealed-capability',
      },
      'authoritative run cancellation',
    );
  });

  it('signals Trigger even when runtime cancellation fails and retries only the failed side', async () => {
    let runtimeAttempts = 0;
    const runtime = {
      cancel: vi.fn(async () => {
        runtimeAttempts += 1;
        if (runtimeAttempts === 1) throw new Error('provider unavailable');
      }),
      cleanup: vi.fn(async () => undefined),
    } as unknown as RuntimeProvider;
    const { checkpoints, cancelTrigger, outbox } = collaborators(runtime);
    await startedEffect(checkpoints, {
      key: 'trigger:run-1',
      kind: 'trigger-workflow-start',
      externalRef: 'trigger-run-1',
    });
    await startedEffect(checkpoints, {
      key: 'runtime:run-1:implementation:1',
      kind: 'runtime-session',
      externalRef: 'runtime-session-1',
    });
    const request = { idempotencyKey: 'cancel:run-1', runId: 'run-1' };

    await expect(outbox.requestCancel(request)).rejects.toThrow(
      'provider unavailable',
    );
    expect(cancelTrigger).toHaveBeenCalledOnce();
    await expect(outbox.requestCancel(request)).resolves.toBeUndefined();
    expect(runtime.cancel).toHaveBeenCalledTimes(2);
    expect(cancelTrigger).toHaveBeenCalledOnce();
  });

  it('conservatively charges an expired crash reservation before releasing it', async () => {
    const repository = new InMemoryDomainRepository();
    const at = isoTimestamp(now);
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Budget cleanup',
      createdAt: at,
      updatedAt: at,
    });
    await repository.createRun({
      id: persistenceId('run', 'run-1'),
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'failed',
      createdAt: at,
      updatedAt: at,
    });
    const runtime = { cleanup: vi.fn() } as unknown as RuntimeProvider;
    const { checkpoints, outbox } = collaborators(runtime, repository);
    await checkpoints.admitSession({
      reservationKey: 'reservation:runtime:run-1:implementation:1',
      projectId: 'project-1',
      runId: 'run-1',
      stepKey: 'implementation',
      estimatedMicrodollars: 700_000,
      workflowSpentMicrodollars: 0,
      dailySpentMicrodollars: 0,
      workflowLimitMicrodollars: 2_000_000,
      dailyLimitMicrodollars: 5_000_000,
      admissionNumerator: 80,
      admissionDenominator: 100,
      now: '2026-08-17T11:00:00.000Z',
      leaseExpiresAt: '2026-08-17T11:21:00.000Z',
    });

    await outbox.requestCleanup({
      idempotencyKey: 'cleanup:run-1',
      runId: 'run-1',
    });
    await expect(
      repository.listUsage(persistenceId('run', 'run-1')),
    ).resolves.toEqual([
      expect.objectContaining({
        model: 'conservative-reservation',
        microdollars: 700_000,
      }),
    ]);
    await expect(
      checkpoints.listExpiredReservations('run-1', now),
    ).resolves.toEqual([]);
  });

  it('stops and charges an orphan before releasing its global concurrency fence', async () => {
    const repository = new InMemoryDomainRepository();
    const at = isoTimestamp('2026-08-17T11:00:00.000Z');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Orphan reconciliation',
      createdAt: at,
      updatedAt: at,
    });
    await repository.createRun({
      id: persistenceId('run', 'run-1'),
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'running',
      createdAt: at,
      updatedAt: at,
    });
    const runtime = {
      cancel: vi.fn(async () => undefined),
      usage: vi.fn(async () => ({
        inputTokens: 11,
        outputTokens: 7,
        runtimeMs: 1_200_000,
      })),
      cleanup: vi.fn(async () => undefined),
    } as unknown as RuntimeProvider;
    const { checkpoints, outbox } = collaborators(runtime, repository);
    await startedEffect(checkpoints, {
      key: 'runtime:run-1:implementation:1',
      kind: 'runtime-session',
      externalRef: 'runtime-session-1',
    });
    await checkpoints.admitSession({
      reservationKey: 'reservation:runtime:run-1:implementation:1',
      projectId: 'project-1',
      runId: 'run-1',
      stepKey: 'implementation',
      estimatedMicrodollars: 700_000,
      workflowSpentMicrodollars: 0,
      dailySpentMicrodollars: 0,
      workflowLimitMicrodollars: 2_000_000,
      dailyLimitMicrodollars: 5_000_000,
      admissionNumerator: 80,
      admissionDenominator: 100,
      now: '2026-08-17T11:00:00.000Z',
      leaseExpiresAt: '2026-08-17T11:21:00.000Z',
    });
    await expect(
      checkpoints.admitSession({
        reservationKey: 'reservation:runtime:run-2:specification:1',
        projectId: 'project-1',
        runId: 'run-2',
        stepKey: 'specification',
        estimatedMicrodollars: 100_000,
        workflowSpentMicrodollars: 0,
        dailySpentMicrodollars: 0,
        workflowLimitMicrodollars: 2_000_000,
        dailyLimitMicrodollars: 5_000_000,
        admissionNumerator: 80,
        admissionDenominator: 100,
        now,
        leaseExpiresAt: '2026-08-17T12:21:00.000Z',
      }),
    ).resolves.toEqual({ admitted: false, reason: 'concurrency' });

    await expect(
      outbox.requestOrphanReconciliation({
        idempotencyKey: 'orphan:run-1',
        runId: 'run-1',
      }),
    ).resolves.toBeUndefined();

    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(runtime.cleanup).toHaveBeenCalledOnce();
    await expect(
      repository.getRun(persistenceId('run', 'run-1')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'orphaned_runtime_session' },
    });
    await expect(
      repository.listUsage(persistenceId('run', 'run-1')),
    ).resolves.toEqual([
      expect.objectContaining({
        model: 'sonnet@pricing-v1',
        microdollars: 123_456,
        inputTokens: 11,
        outputTokens: 7,
      }),
    ]);
    await expect(
      checkpoints.listExpiredReservations('run-1', now),
    ).resolves.toEqual([]);
  });

  it('requires two durable absence observations before conservatively releasing an ambiguous start', async () => {
    const repository = new InMemoryDomainRepository();
    const at = isoTimestamp('2026-08-17T11:00:00.000Z');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Absent start',
      createdAt: at,
      updatedAt: at,
    });
    await repository.createRun({
      id: persistenceId('run', 'run-1'),
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'failed',
      createdAt: at,
      updatedAt: at,
    });
    const runtime = {
      reconcileStart: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
      cleanupAccess: vi.fn(async () => undefined),
    } as unknown as RuntimeProvider;
    let currentTime = now;
    const { checkpoints, outbox } = collaborators(
      runtime,
      repository,
      () => currentTime,
    );
    const effect = await checkpoints.claimEffect(
      {
        key: 'runtime:run-1:implementation:1',
        runId: 'run-1',
        kind: 'runtime-session',
        inputFingerprint: 'd'.repeat(64),
        createdAt: at,
        updatedAt: at,
      },
      {
        ownerId: 'crashed-trigger-attempt',
        now: at,
        leaseExpiresAt: '2026-08-17T11:21:00.000Z',
      },
    );
    await checkpoints.markEffectStarted(
      {
        key: effect.key,
        ownerId: 'crashed-trigger-attempt',
        leaseVersion: effect.leaseVersion,
      },
      at,
    );
    await checkpoints.admitSession({
      reservationKey: 'reservation:runtime:run-1:implementation:1',
      projectId: 'project-1',
      runId: 'run-1',
      stepKey: 'implementation',
      estimatedMicrodollars: 700_000,
      workflowSpentMicrodollars: 0,
      dailySpentMicrodollars: 0,
      workflowLimitMicrodollars: 2_000_000,
      dailyLimitMicrodollars: 5_000_000,
      admissionNumerator: 80,
      admissionDenominator: 100,
      now: at,
      leaseExpiresAt: '2026-08-17T11:21:00.000Z',
    });
    const request = {
      idempotencyKey: 'orphan:run-1',
      runId: 'run-1',
    } as const;

    await expect(outbox.requestOrphanReconciliation(request)).rejects.toThrow(
      'independent reconciliation',
    );
    await expect(
      outbox.requestCleanup({
        idempotencyKey: 'cleanup:run-1',
        runId: 'run-1',
      }),
    ).resolves.toBeUndefined();
    await expect(
      checkpoints.listExpiredReservations('run-1', now),
    ).resolves.toHaveLength(1);
    await expect(outbox.requestOrphanReconciliation(request)).rejects.toThrow(
      'visibility delay',
    );
    await expect(
      checkpoints.listExpiredReservations('run-1', now),
    ).resolves.toHaveLength(1);
    currentTime = '2026-08-17T12:00:29.999Z';
    await expect(outbox.requestOrphanReconciliation(request)).rejects.toThrow(
      'visibility delay',
    );
    currentTime = '2026-08-17T12:00:30.000Z';
    await expect(
      outbox.requestOrphanReconciliation(request),
    ).resolves.toBeUndefined();
    expect(runtime.reconcileStart).toHaveBeenCalledTimes(4);
    expect(runtime.cleanupAccess).toHaveBeenCalledOnce();
    await expect(
      checkpoints.listExpiredReservations('run-1', now),
    ).resolves.toEqual([]);
  });

  it('discovers, seals, cancels, and settles an expired ambiguous start with no external reference', async () => {
    const repository = new InMemoryDomainRepository();
    const at = isoTimestamp('2026-08-17T11:00:00.000Z');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Ambiguous recovery',
      createdAt: at,
      updatedAt: at,
    });
    await repository.createRun({
      id: persistenceId('run', 'run-1'),
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'running',
      createdAt: at,
      updatedAt: at,
    });
    const recovered = { id: 'runtime-session-recovered' };
    const runtime = {
      reconcileStart: vi.fn(async () => recovered),
      cancel: vi.fn(async () => undefined),
      usage: vi.fn(async () => ({
        inputTokens: 3,
        outputTokens: 2,
        runtimeMs: 10_000,
      })),
      cleanup: vi.fn(async () => undefined),
    } as unknown as RuntimeProvider;
    const { checkpoints, outbox } = collaborators(runtime, repository);
    const effect = await checkpoints.claimEffect(
      {
        key: 'runtime:run-1:implementation:1',
        runId: 'run-1',
        kind: 'runtime-session',
        inputFingerprint: 'c'.repeat(64),
        createdAt: at,
        updatedAt: at,
      },
      {
        ownerId: 'crashed-trigger-attempt',
        now: at,
        leaseExpiresAt: '2026-08-17T11:21:00.000Z',
      },
    );
    await checkpoints.markEffectStarted(
      {
        key: effect.key,
        ownerId: 'crashed-trigger-attempt',
        leaseVersion: effect.leaseVersion,
      },
      at,
    );
    await checkpoints.admitSession({
      reservationKey: 'reservation:runtime:run-1:implementation:1',
      projectId: 'project-1',
      runId: 'run-1',
      stepKey: 'implementation',
      estimatedMicrodollars: 700_000,
      workflowSpentMicrodollars: 0,
      dailySpentMicrodollars: 0,
      workflowLimitMicrodollars: 2_000_000,
      dailyLimitMicrodollars: 5_000_000,
      admissionNumerator: 80,
      admissionDenominator: 100,
      now: at,
      leaseExpiresAt: '2026-08-17T11:21:00.000Z',
    });

    await outbox.requestOrphanReconciliation({
      idempotencyKey: 'orphan:run-1',
      runId: 'run-1',
    });

    expect(runtime.reconcileStart).toHaveBeenCalledOnce();
    expect(runtime.cancel).toHaveBeenCalledWith(
      recovered,
      'runtime session lease expired',
    );
    expect(runtime.cleanup).toHaveBeenCalledWith(recovered);
    await expect(
      checkpoints.getEffect('runtime:run-1:implementation:1'),
    ).resolves.toMatchObject({ externalRef: recovered.id });
    await expect(
      checkpoints.listExpiredReservations('run-1', now),
    ).resolves.toEqual([]);
  });

  it('persists a recovered cancellation reference so cleanup survives a missing original ref', async () => {
    const runtime = {
      reconcileStart: vi.fn(async () => ({ id: 'runtime-recovered-cancel' })),
      cancel: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    } as unknown as RuntimeProvider;
    const { checkpoints, outbox } = collaborators(runtime);
    await startedEffect(checkpoints, {
      key: 'runtime:run-1:implementation:1',
      kind: 'runtime-session',
    });

    await outbox.requestCancel({
      idempotencyKey: 'cancel:run-1',
      runId: 'run-1',
    });
    await outbox.requestCleanup({
      idempotencyKey: 'cleanup:run-1',
      runId: 'run-1',
    });

    expect(runtime.reconcileStart).toHaveBeenCalledOnce();
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(runtime.cleanup).toHaveBeenCalledOnce();
    await expect(checkpoints.listEffects('run-1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'runtime-session-cancel',
          output: expect.objectContaining({
            externalRef: 'runtime-recovered-cancel',
            runtimeEffectKey: 'runtime:run-1:implementation:1',
          }),
        }),
        expect.objectContaining({
          kind: 'runtime-session-cleanup',
          status: 'succeeded',
        }),
      ]),
    );
  });

  it('replays an outer cancellation after its recovered runtime cancel already committed', async () => {
    const runtime = {
      reconcileStart: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    } as unknown as RuntimeProvider;
    const { checkpoints, outbox } = collaborators(runtime);
    await startedEffect(checkpoints, {
      key: 'runtime:run-1:implementation:1',
      kind: 'runtime-session',
    });
    const child = await checkpoints.claimEffect(
      {
        key: 'cancel:run-1:runtime:runtime-recovered',
        runId: 'run-1',
        kind: 'runtime-session-cancel',
        inputFingerprint: 'f'.repeat(64),
        createdAt: now,
        updatedAt: now,
      },
      {
        ownerId: 'seed-cancel',
        now,
        leaseExpiresAt: '2026-08-17T12:02:00.000Z',
      },
    );
    const childLease = {
      key: child.key,
      ownerId: 'seed-cancel',
      leaseVersion: child.leaseVersion,
    };
    await checkpoints.markEffectStarted(childLease, now);
    await checkpoints.completeEffect(
      childLease,
      {
        externalRef: 'runtime-recovered',
        runtimeEffectKey: 'runtime:run-1:implementation:1',
        cancelled: true,
      },
      now,
    );

    await expect(
      outbox.requestCancel({
        idempotencyKey: 'cancel:run-1',
        runId: 'run-1',
      }),
    ).resolves.toBeUndefined();
    expect(runtime.reconcileStart).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
  });
});
