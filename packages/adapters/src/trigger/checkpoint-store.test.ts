import { describe, expect, it } from 'vitest';

import {
  InMemoryWorkflowCheckpointStore,
  WorkflowCheckpointConflictError,
} from './checkpoint-store.js';

const now = '2026-08-17T12:00:00.000Z';
const claim = {
  ownerId: 'owner-1',
  now,
  leaseExpiresAt: '2026-08-17T12:05:00.000Z',
};

describe('workflow checkpoint store', () => {
  it('replays the same effect and conflicts on changed input', async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const effect = {
      key: 'runtime:run-1:spec:1',
      runId: 'run-1',
      kind: 'runtime-session',
      inputFingerprint: 'a'.repeat(64),
      createdAt: now,
      updatedAt: now,
    };
    await expect(store.claimEffect(effect, claim)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(store.claimEffect(effect, claim)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(
      store.claimEffect({ ...effect, inputFingerprint: 'b'.repeat(64) }, claim),
    ).rejects.toBeInstanceOf(WorkflowCheckpointConflictError);
  });

  it('stops admission at 80 percent and enforces one live session per project', async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const request = {
      reservationKey: 'reservation:run-1:specification',
      projectId: 'project-1',
      runId: 'run-1',
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
    };
    await expect(store.admitSession(request)).resolves.toEqual({
      admitted: true,
    });
    await expect(
      store.admitSession({
        ...request,
        reservationKey: 'reservation:run-2:specification',
        runId: 'run-2',
      }),
    ).resolves.toEqual({ admitted: false, reason: 'concurrency' });
    await store.releaseSession('project-1', 'run-1', 'specification');
    await expect(
      store.admitSession({
        ...request,
        reservationKey: 'reservation:run-1:workflow-cap',
        stepKey: 'workflow-cap',
        workflowSpentMicrodollars: 1_600_000,
      }),
    ).resolves.toEqual({ admitted: false, reason: 'workflow_budget' });
    await expect(
      store.admitSession({
        ...request,
        reservationKey: 'reservation:run-1:daily-cap',
        stepKey: 'daily-cap',
        dailySpentMicrodollars: 4_000_000,
      }),
    ).resolves.toEqual({ admitted: false, reason: 'daily_budget' });
  });

  it('does not let an expired reservation release another project session lease', async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const original = {
      reservationKey: 'reservation:run-1:specification',
      projectId: 'project-1',
      runId: 'run-1',
      stepKey: 'specification',
      estimatedMicrodollars: 100_000,
      workflowSpentMicrodollars: 0,
      dailySpentMicrodollars: 0,
      workflowLimitMicrodollars: 2_000_000,
      dailyLimitMicrodollars: 5_000_000,
      admissionNumerator: 80,
      admissionDenominator: 100,
      now,
      leaseExpiresAt: '2026-08-17T12:01:00.000Z',
    } as const;
    await expect(store.admitSession(original)).resolves.toEqual({
      admitted: true,
    });
    await expect(
      store.admitSession({
        ...original,
        reservationKey: 'reservation:run-2:specification',
        runId: 'run-2',
        now: '2026-08-17T12:02:00.000Z',
        leaseExpiresAt: '2026-08-17T12:22:00.000Z',
      }),
    ).resolves.toEqual({ admitted: false, reason: 'concurrency' });
    await store.releaseSession('project-1', 'run-1', 'specification');
    await expect(
      store.admitSession({
        ...original,
        reservationKey: 'reservation:run-2:specification',
        runId: 'run-2',
        now: '2026-08-17T12:02:01.000Z',
        leaseExpiresAt: '2026-08-17T12:22:01.000Z',
      }),
    ).resolves.toEqual({ admitted: true });
  });

  it('admits concurrent sessions for different projects', async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const base = {
      estimatedMicrodollars: 100_000,
      workflowSpentMicrodollars: 0,
      dailySpentMicrodollars: 0,
      workflowLimitMicrodollars: 2_000_000,
      dailyLimitMicrodollars: 5_000_000,
      admissionNumerator: 80,
      admissionDenominator: 100,
      now,
      leaseExpiresAt: '2026-08-17T12:21:00.000Z',
    } as const;
    await expect(
      store.admitSession({
        ...base,
        reservationKey: 'reservation:run-1:specification',
        projectId: 'project-1',
        runId: 'run-1',
        stepKey: 'specification',
      }),
    ).resolves.toEqual({ admitted: true });
    await expect(
      store.admitSession({
        ...base,
        reservationKey: 'reservation:run-2:specification',
        projectId: 'project-2',
        runId: 'run-2',
        stepKey: 'specification',
      }),
    ).resolves.toEqual({ admitted: true });
  });

  it('does not treat an ambiguous started runtime effect as safe to restart', async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const effect = await store.claimEffect(
      {
        key: 'runtime:run-1:spec:1',
        runId: 'run-1',
        kind: 'runtime-session',
        inputFingerprint: 'a'.repeat(64),
        createdAt: now,
        updatedAt: now,
      },
      claim,
    );
    await store.markEffectStarted(
      {
        key: effect.key,
        ownerId: claim.ownerId,
        leaseVersion: effect.leaseVersion,
      },
      now,
    );
    const stored = await store.getEffect('runtime:run-1:spec:1');
    expect(stored).toMatchObject({ status: 'started' });
    expect(stored?.externalRef).toBeUndefined();
  });

  it('fences concurrent owners and rejects a stale owner after takeover', async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const draft = {
      key: 'publisher:run-1',
      runId: 'run-1',
      kind: 'trusted-draft-publication',
      inputFingerprint: 'a'.repeat(64),
      createdAt: now,
      updatedAt: now,
    };
    const first = await store.claimEffect(draft, claim);
    const contended = await store.claimEffect(draft, {
      ownerId: 'owner-2',
      now: '2026-08-17T12:01:00.000Z',
      leaseExpiresAt: '2026-08-17T12:06:00.000Z',
    });
    expect(contended.ownerId).toBe('owner-1');
    const takenOver = await store.claimEffect(draft, {
      ownerId: 'owner-2',
      now: '2026-08-17T12:05:00.001Z',
      leaseExpiresAt: '2026-08-17T12:10:00.000Z',
    });
    expect(takenOver).toMatchObject({ ownerId: 'owner-2', leaseVersion: 2 });
    await expect(
      store.markEffectStarted(
        {
          key: first.key,
          ownerId: 'owner-1',
          leaseVersion: first.leaseVersion,
        },
        now,
      ),
    ).rejects.toBeInstanceOf(WorkflowCheckpointConflictError);
  });
});
