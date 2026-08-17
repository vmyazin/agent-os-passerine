import { InMemoryDomainRepository } from '@agentos/adapters';
import { isoTimestamp, persistenceId } from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { reconcileWorkflowOutbox } from './workflow-reconciliation';
import type { WorkflowDispatchOutbox } from './control-plane-service';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');

describe('workflow outbox reconciliation', () => {
  it('redelivers durable start, approval, and cancellation intents idempotently', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'project-1');
    await repository.createProject({
      id: projectId,
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    const revisionId = persistenceId('configRevision', 'revision-1');
    await repository.createConfigRevision({
      id: revisionId,
      projectId,
      revision: 1,
      config: {},
      repositorySha: 'a'.repeat(40),
      configDigest: 'config',
      modelDigest: 'model',
      promptDigest: 'prompt',
      environmentDigest: 'environment',
      policyDigest: 'policy',
      createdAt: now,
    });
    for (const [id, status] of [
      ['pending-run', 'pending'],
      ['cancelled-run', 'cancelled'],
      ['waiting-run', 'waiting'],
    ] as const) {
      await repository.createRun({
        id: persistenceId('run', id),
        projectId,
        pipeline: 'feature',
        status,
        ...(status === 'pending' ? { configRevisionId: revisionId } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
    const waitingRun = persistenceId('run', 'waiting-run');
    await repository.createApproval({
      id: persistenceId('approval', 'approval-1'),
      runId: waitingRun,
      scope: 'feature-spec-and-dod',
      fingerprint: 'scope-hash',
      status: 'pending',
      createdAt: now,
      expiresAt: isoTimestamp('2026-08-17T13:00:00.000Z'),
    });
    await repository.consumeApprovalWithEvent(
      {
        approvalId: persistenceId('approval', 'approval-1'),
        runId: waitingRun,
        scope: 'feature-spec-and-dod',
        fingerprint: 'scope-hash',
        consumedAt: now,
      },
      {
        runId: waitingRun,
        eventId: persistenceId('event', 'approval-event'),
        fingerprint: 'event-fingerprint',
        type: 'approval.approved',
        payload: { approvalId: 'approval-1', scopeHash: 'scope-hash' },
        occurredAt: now,
      },
    );
    const seen: string[] = [];
    const outbox: WorkflowDispatchOutbox = {
      requestStart: async ({ idempotencyKey }) => {
        seen.push(idempotencyKey);
      },
      requestApprovalResume: async ({ idempotencyKey }) => {
        seen.push(idempotencyKey);
      },
      requestCancel: async ({ idempotencyKey }) => {
        seen.push(idempotencyKey);
      },
    };
    await expect(
      reconcileWorkflowOutbox(repository, outbox, () => now),
    ).resolves.toEqual({
      scannedRuns: 3,
      delivered: 4,
      failed: 0,
    });
    expect(seen.sort()).toEqual([
      'workflow-cancel:cancelled-run',
      'workflow-resume:approval-1:approve',
      'workflow-start:pending-run',
    ]);
  });

  it('fails an over-deadline active run and durably requests cancel and cleanup', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'deadline-project');
    const createdAt = isoTimestamp('2026-08-17T10:00:00.000Z');
    await repository.createProject({
      id: projectId,
      name: 'Deadline',
      createdAt,
      updatedAt: createdAt,
    });
    const runId = persistenceId('run', 'deadline-run');
    await repository.createRun({
      id: runId,
      projectId,
      pipeline: 'feature',
      status: 'running',
      createdAt,
      updatedAt: createdAt,
    });
    const approvalId = persistenceId('approval', 'deadline-approval');
    await repository.createApproval({
      id: approvalId,
      runId,
      scope: 'feature-spec-and-dod',
      fingerprint: 'deadline-scope',
      status: 'pending',
      createdAt,
      expiresAt: isoTimestamp('2026-08-17T11:00:00.000Z'),
    });
    const seen: string[] = [];
    const outbox: WorkflowDispatchOutbox = {
      requestStart: async () => undefined,
      requestApprovalResume: async () => undefined,
      requestCancel: async ({ idempotencyKey }) => {
        seen.push(idempotencyKey);
      },
      requestCleanup: async ({ idempotencyKey }) => {
        seen.push(idempotencyKey);
      },
    };

    await expect(
      reconcileWorkflowOutbox(repository, outbox, () => now),
    ).resolves.toEqual({ scannedRuns: 1, delivered: 2, failed: 0 });
    await expect(repository.getRun(runId)).resolves.toMatchObject({
      status: 'failed',
      output: { status: 'failed', reason: 'workflow_deadline_exceeded' },
      error: { code: 'workflow_deadline_exceeded' },
      stateVersion: 1,
    });
    await expect(repository.getApproval(approvalId)).resolves.toMatchObject({
      status: 'expired',
    });
    expect(seen).toEqual([
      'workflow-cancel:deadline-run',
      'workflow-cleanup:deadline-run',
    ]);
  });

  it('advances beyond one thousand old runs without starving later intents', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'fairness-project');
    await repository.createProject({
      id: projectId,
      name: 'Fairness',
      createdAt: now,
      updatedAt: now,
    });
    for (let index = 0; index < 1_001; index += 1) {
      await repository.createRun({
        id: persistenceId('run', `cancelled-${String(index).padStart(4, '0')}`),
        projectId,
        pipeline: 'feature',
        status: 'cancelled',
        createdAt: now,
        updatedAt: now,
      });
    }
    const cancelled: string[] = [];
    const outbox: WorkflowDispatchOutbox = {
      requestStart: async () => undefined,
      requestApprovalResume: async () => undefined,
      requestCancel: async ({ runId }) => {
        cancelled.push(runId);
      },
    };

    await expect(
      reconcileWorkflowOutbox(repository, outbox, () => now),
    ).resolves.toEqual({ scannedRuns: 1_001, delivered: 1_001, failed: 0 });
    expect(cancelled).toHaveLength(1_001);
    expect(cancelled).toContain('cancelled-1000');
  });
});
