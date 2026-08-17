import { describe, expect, it } from 'vitest';

import {
  InMemoryWorkflowCheckpointStore,
  WorkflowCheckpointConflictError,
} from './checkpoint-store.js';

const now = '2026-08-17T12:00:00.000Z';

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
    await expect(store.claimEffect(effect)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(store.claimEffect(effect)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(
      store.claimEffect({ ...effect, inputFingerprint: 'b'.repeat(64) }),
    ).rejects.toBeInstanceOf(WorkflowCheckpointConflictError);
  });

  it('stops admission at 80 percent and enforces one global live session', async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const request = {
      runId: 'run-1',
      stepKey: 'specification',
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
      store.admitSession({ ...request, runId: 'run-2' }),
    ).resolves.toEqual({ admitted: false, reason: 'concurrency' });
    await store.releaseSession('run-1', 'specification');
    await expect(
      store.admitSession({ ...request, workflowSpentMicrodollars: 1_600_000 }),
    ).resolves.toEqual({ admitted: false, reason: 'workflow_budget' });
    await expect(
      store.admitSession({ ...request, dailySpentMicrodollars: 4_000_000 }),
    ).resolves.toEqual({ admitted: false, reason: 'daily_budget' });
  });

  it('does not treat an ambiguous started runtime effect as safe to restart', async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    await store.claimEffect({
      key: 'runtime:run-1:spec:1',
      runId: 'run-1',
      kind: 'runtime-session',
      inputFingerprint: 'a'.repeat(64),
      createdAt: now,
      updatedAt: now,
    });
    await store.markEffectStarted('runtime:run-1:spec:1', now);
    const effect = await store.getEffect('runtime:run-1:spec:1');
    expect(effect).toMatchObject({ status: 'started' });
    expect(effect?.externalRef).toBeUndefined();
  });
});
