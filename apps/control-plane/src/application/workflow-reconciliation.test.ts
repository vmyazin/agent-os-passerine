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
    await expect(reconcileWorkflowOutbox(repository, outbox)).resolves.toEqual({
      scannedRuns: 3,
      delivered: 3,
      failed: 0,
    });
    expect(seen.sort()).toEqual([
      'workflow-cancel:cancelled-run',
      'workflow-resume:approval-1:approve',
      'workflow-start:pending-run',
    ]);
  });
});
