import { createHash } from 'node:crypto';

import { InMemoryDomainRepository } from '@agentos/adapters';
import {
  canonicalJsonValue,
  isoTimestamp,
  loadAgentOsConfig,
  persistenceId,
  type JsonValue,
  type TimestampListCursor,
  type WorkflowRunId,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { reconcileWorkflowOutbox } from './workflow-reconciliation';
import type { WorkflowDispatchOutbox } from './control-plane-service';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');

function goalConfig(timeoutMs = 3_600_000): JsonValue {
  const config = loadAgentOsConfig(`
version: 1
project: { name: Goal Reconciliation }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 3, maxRetries: 1, timeoutMs: ${String(timeoutMs)} }
runtime: { provider: local }
`);
  return JSON.parse(canonicalJsonValue(config)) as JsonValue;
}

describe('workflow outbox reconciliation', () => {
  it('repairs a pending goal snapshot and criterion set before goal dispatch', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'goal-repair-project');
    const runId = persistenceId('run', 'goal-repair-run');
    const revisionId = persistenceId('configRevision', 'goal-repair-revision');
    const provenance = {
      repositorySha: 'a'.repeat(40),
      configDigest: 'b'.repeat(64),
      modelDigest: 'c'.repeat(64),
      promptDigest: 'd'.repeat(64),
      environmentDigest: 'e'.repeat(64),
      policyDigest: 'f'.repeat(64),
    };
    await repository.createProject({
      id: projectId,
      name: 'Goal repair',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createConfigRevision({
      id: revisionId,
      projectId,
      revision: 1,
      config: goalConfig(),
      ...provenance,
      createdAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId,
      configRevisionId: revisionId,
      pipeline: 'goal',
      status: 'pending',
      input: {
        idempotencyKey: 'goal-repair',
        title: 'Repair me',
        description: 'Restore durable goal inputs.',
        provenance,
        criteria: [
          {
            id: 'tests',
            type: 'command',
            description: 'Tests pass',
            command: 'pnpm test',
          },
        ],
      },
      createdAt: now,
      updatedAt: now,
    });
    const starts: unknown[] = [];
    const outbox: WorkflowDispatchOutbox = {
      requestStart: async (request) => {
        starts.push(request);
      },
      requestApprovalResume: async () => undefined,
    };

    await expect(
      reconcileWorkflowOutbox(repository, outbox, () => now),
    ).resolves.toEqual({ scannedRuns: 1, delivered: 3, failed: 0 });
    await expect(repository.listConfigSnapshots(runId)).resolves.toHaveLength(
      1,
    );
    await expect(repository.listGoalCriteria(runId)).resolves.toEqual([
      expect.objectContaining({
        ordinal: 0,
        definition: expect.objectContaining({ id: 'tests' }),
      }),
    ]);
    expect(starts).toEqual([
      {
        idempotencyKey: `workflow-start:${runId}`,
        runId,
        pipeline: 'goal',
      },
    ]);
  });

  it('uses the configured bounded goal timeout before the one-hour ceiling', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'goal-timeout-project');
    const runId = persistenceId('run', 'goal-timeout-run');
    const revisionId = persistenceId('configRevision', 'goal-timeout-revision');
    const createdAt = isoTimestamp('2026-08-17T11:59:58.000Z');
    await repository.createProject({
      id: projectId,
      name: 'Goal timeout',
      createdAt,
      updatedAt: createdAt,
    });
    await repository.createConfigRevision({
      id: revisionId,
      projectId,
      revision: 1,
      config: goalConfig(1_000),
      repositorySha: 'a'.repeat(40),
      configDigest: 'b'.repeat(64),
      modelDigest: 'c'.repeat(64),
      promptDigest: 'd'.repeat(64),
      environmentDigest: 'e'.repeat(64),
      policyDigest: 'f'.repeat(64),
      createdAt,
    });
    await repository.createRun({
      id: runId,
      projectId,
      configRevisionId: revisionId,
      pipeline: 'goal',
      status: 'running',
      createdAt,
      updatedAt: createdAt,
    });
    await repository.createConfigSnapshot({
      id: persistenceId('configSnapshot', 'goal-timeout-snapshot'),
      runId,
      configRevisionId: revisionId,
      config: goalConfig(1_000),
      repositorySha: 'a'.repeat(40),
      configDigest: 'b'.repeat(64),
      modelDigest: 'c'.repeat(64),
      promptDigest: 'd'.repeat(64),
      environmentDigest: 'e'.repeat(64),
      policyDigest: 'f'.repeat(64),
      createdAt,
    });
    const delivered: string[] = [];
    const outbox: WorkflowDispatchOutbox = {
      requestStart: async () => undefined,
      requestApprovalResume: async () => undefined,
      requestCancel: async ({ runId: deliveredRunId }) => {
        delivered.push(`cancel:${deliveredRunId}`);
      },
      requestCleanup: async ({ runId: deliveredRunId }) => {
        delivered.push(`cleanup:${deliveredRunId}`);
      },
    };

    await reconcileWorkflowOutbox(repository, outbox, () => now);

    await expect(repository.getRun(runId)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'workflow_deadline_exceeded' },
    });
    expect(delivered).toEqual([`cancel:${runId}`, `cleanup:${runId}`]);
  });

  it('cancels every recorded active child of a cancelled goal', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'goal-cancel-project');
    const goalRunId = persistenceId('run', 'goal-cancel-parent');
    const childRunId = persistenceId(
      'run',
      `goal-child-${createHash('sha256')
        .update(`${goalRunId}\u00001`)
        .digest('hex')}`,
    );
    await repository.createProject({
      id: projectId,
      name: 'Goal cancellation',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: goalRunId,
      projectId,
      pipeline: 'goal',
      status: 'cancelled',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: childRunId,
      projectId,
      pipeline: 'feature',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
    await repository.appendGoalProgress({
      id: persistenceId('goalProgress', `goal:${goalRunId}:step:1:child`),
      runId: goalRunId,
      step: 1,
      status: 'pending',
      payload: {
        version: 'goal-child-attempt-v1',
        childRunId,
      },
      recordedAt: now,
    });
    const cancelled = new Set<string>();
    const outbox: WorkflowDispatchOutbox = {
      requestStart: async () => undefined,
      requestApprovalResume: async () => undefined,
      requestCancel: async ({ runId }) => {
        cancelled.add(runId);
      },
    };

    await reconcileWorkflowOutbox(repository, outbox, () => now);

    await expect(repository.getRun(childRunId)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(cancelled).toEqual(new Set([goalRunId, childRunId]));
  });

  it('does not dispatch a pending deterministic goal child as a standalone feature', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'goal-child-owner-project');
    const parentRunId = persistenceId('run', 'goal-child-owner-parent');
    const childRunId = persistenceId(
      'run',
      `goal-child-${createHash('sha256')
        .update(`${parentRunId}\u00001`)
        .digest('hex')}`,
    );
    const revisionId = persistenceId(
      'configRevision',
      'goal-child-owner-revision',
    );
    await repository.createProject({
      id: projectId,
      name: 'Goal child owner',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createConfigRevision({
      id: revisionId,
      projectId,
      revision: 1,
      config: goalConfig(),
      repositorySha: 'a'.repeat(40),
      configDigest: 'b'.repeat(64),
      modelDigest: 'c'.repeat(64),
      promptDigest: 'd'.repeat(64),
      environmentDigest: 'e'.repeat(64),
      policyDigest: 'f'.repeat(64),
      createdAt: now,
    });
    await repository.createRun({
      id: parentRunId,
      projectId,
      configRevisionId: revisionId,
      pipeline: 'goal',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: childRunId,
      projectId,
      configRevisionId: revisionId,
      pipeline: 'feature',
      status: 'pending',
      input: {
        idempotencyKey: `goal:${parentRunId}:step:1`,
      },
      createdAt: now,
      updatedAt: now,
    });
    await repository.createConfigSnapshot({
      id: persistenceId('configSnapshot', 'goal-child-owner-snapshot'),
      runId: childRunId,
      configRevisionId: revisionId,
      config: goalConfig(),
      repositorySha: 'a'.repeat(40),
      configDigest: 'b'.repeat(64),
      modelDigest: 'c'.repeat(64),
      promptDigest: 'd'.repeat(64),
      environmentDigest: 'e'.repeat(64),
      policyDigest: 'f'.repeat(64),
      createdAt: now,
    });
    await repository.appendGoalProgress({
      id: persistenceId('goalProgress', `goal:${parentRunId}:step:1:child`),
      runId: parentRunId,
      step: 1,
      status: 'pending',
      payload: {
        version: 'goal-child-attempt-v1',
        childRunId,
      },
      recordedAt: now,
    });
    const starts: string[] = [];
    const outbox: WorkflowDispatchOutbox = {
      requestStart: async ({ runId }) => {
        starts.push(runId);
      },
      requestApprovalResume: async () => undefined,
    };

    await reconcileWorkflowOutbox(repository, outbox, () => now);

    expect(starts).toEqual([]);
    await expect(repository.getRun(childRunId)).resolves.toMatchObject({
      status: 'pending',
    });
  });

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

  it('resumes after the last durably scanned run when an invocation is interrupted', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'cursor-project');
    await repository.createProject({
      id: projectId,
      name: 'Cursor recovery',
      createdAt: now,
      updatedAt: now,
    });
    for (let index = 0; index < 125; index += 1) {
      await repository.createRun({
        id: persistenceId('run', `cursor-${String(index).padStart(3, '0')}`),
        projectId,
        pipeline: 'feature',
        status: 'cancelled',
        createdAt: now,
        updatedAt: now,
      });
    }
    let cursor: TimestampListCursor<WorkflowRunId> | undefined;
    const cursorStore = {
      load: async () => cursor,
      save: async (value: typeof cursor) => {
        cursor = value;
      },
    };
    const baseListRuns = repository.listRuns.bind(repository);
    let listCalls = 0;
    const interruptedRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property !== 'listRuns') {
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (...args: Parameters<typeof repository.listRuns>) => {
          listCalls += 1;
          if (listCalls === 2) throw new Error('invocation interrupted');
          return baseListRuns(...args);
        };
      },
    });
    const cancelled: string[] = [];
    const outbox: WorkflowDispatchOutbox = {
      requestStart: async () => undefined,
      requestApprovalResume: async () => undefined,
      requestCancel: async ({ runId }) => {
        cancelled.push(runId);
      },
    };

    await expect(
      reconcileWorkflowOutbox(
        interruptedRepository,
        outbox,
        () => now,
        cursorStore,
      ),
    ).rejects.toThrow('invocation interrupted');
    expect(cancelled).toHaveLength(100);
    expect(cursor?.id).toBe('cursor-099');

    await expect(
      reconcileWorkflowOutbox(repository, outbox, () => now, cursorStore),
    ).resolves.toEqual({ scannedRuns: 25, delivered: 25, failed: 0 });
    expect(cancelled).toHaveLength(125);
    expect(cancelled).toContain('cursor-124');
    expect(cursor).toBeUndefined();
  });

  it('does not run terminal cleanup in the same pass when orphan reconciliation needs another observation', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'orphan-gate-project');
    const runId = persistenceId('run', 'orphan-gate-run');
    await repository.createProject({
      id: projectId,
      name: 'Orphan gate',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId,
      pipeline: 'feature',
      status: 'failed',
      createdAt: now,
      updatedAt: now,
    });
    let cleanupCalls = 0;
    const outbox: WorkflowDispatchOutbox = {
      requestStart: async () => undefined,
      requestApprovalResume: async () => undefined,
      requestOrphanReconciliation: async () => {
        throw new Error('independent reconciliation required');
      },
      requestCleanup: async () => {
        cleanupCalls += 1;
      },
    };

    await expect(
      reconcileWorkflowOutbox(repository, outbox, () => now),
    ).resolves.toEqual({ scannedRuns: 1, delivered: 0, failed: 1 });
    expect(cleanupCalls).toBe(0);
  });
});
