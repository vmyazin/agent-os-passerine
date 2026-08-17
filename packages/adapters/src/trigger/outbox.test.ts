import {
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

async function startedEffect(
  store: InMemoryWorkflowCheckpointStore,
  input: { key: string; kind: string; externalRef: string },
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
  await store.attachExternalRef(lease, input.externalRef, now);
}

function collaborators(
  runtime?: RuntimeProvider,
  repository?: DomainRepository,
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
        cancel: cancelTrigger,
      },
      approval: {
        create: vi.fn(),
        wait: vi.fn(),
        wake: vi.fn(),
      },
      clock: () => now,
      ...(runtime === undefined ? {} : { runtime }),
      ...(repository === undefined ? {} : { repository }),
      ...(runtime === undefined
        ? {}
        : {
            runtimeHandles: {
              load: async (externalId: string) => ({
                id: externalId,
                ownershipCapability: 'sealed-capability',
              }),
              markCancelled: vi.fn(async () => undefined),
              markCleaned: vi.fn(async () => undefined),
            },
          }),
    }),
  };
}

describe('durable Trigger outbox cancellation', () => {
  it('does not stop Trigger when an active runtime cannot be cancelled safely', async () => {
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

    expect(cancelTrigger).not.toHaveBeenCalled();
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
});
