import { InMemoryDomainRepository } from '@agentos/adapters';
import { isoTimestamp, persistenceId } from '@agentos/core';
import { describe, expect, it } from 'vitest';

import {
  ControlPlaneService,
  type WorkflowDispatchOutbox,
} from './control-plane-service';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');
const ids = (kind: string, key: string) =>
  persistenceId(kind as never, `${kind}-${key}`);

class FakeOutbox implements WorkflowDispatchOutbox {
  readonly starts = new Map<string, unknown>();
  readonly resumes = new Map<string, unknown>();
  readonly cancellations = new Map<string, unknown>();
  async requestStart(request: { idempotencyKey: string }) {
    this.starts.set(request.idempotencyKey, request);
  }
  async requestApprovalResume(request: { idempotencyKey: string }) {
    this.resumes.set(request.idempotencyKey, request);
  }
  async requestCancel(request: { idempotencyKey: string }) {
    this.cancellations.set(request.idempotencyKey, request);
  }
}

describe('control-plane workflow dispatch outbox', () => {
  it('requests one idempotent start only after the durable feature run exists', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    const outbox = new FakeOutbox();
    const service = new ControlPlaneService(repository, () => now, ids, outbox);
    const input = {
      projectId: 'project-1',
      title: 'Status route',
      description: 'Add a route.',
      repositorySha: 'a'.repeat(40),
      configDigest: 'config',
      modelDigest: 'model',
      promptDigest: 'prompt',
      environmentDigest: 'environment',
      policyDigest: 'policy',
    };
    const first = await service.createFeatureRun('request-1', input);
    await service.createFeatureRun('request-1', input);
    expect(
      await repository.getRun(persistenceId('run', first.id)),
    ).toBeDefined();
    expect([...outbox.starts.keys()]).toEqual([`workflow-start:${first.id}`]);
  });

  it('signals a wake only after the scoped approval decision is durable', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'run-1');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createApproval({
      id: persistenceId('approval', 'approval-1'),
      runId,
      scope: 'feature-spec-and-dod',
      fingerprint: 'scope-hash',
      status: 'pending',
      createdAt: now,
      expiresAt: isoTimestamp('2026-08-17T13:00:00.000Z'),
    });
    const outbox = new FakeOutbox();
    const service = new ControlPlaneService(repository, () => now, ids, outbox);
    await service.consumeApproval(
      'approval-1',
      'approve',
      'decision-1',
      'scope-hash',
    );
    const event = (await repository.listEvents(runId))[0];
    expect(event?.type).toBe('approval.approved');
    expect([...outbox.resumes.values()]).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        approvalId: 'approval-1',
        scopeHash: 'scope-hash',
        decision: 'approve',
      }),
    ]);
  });

  it('leaves durable intent reconcilable when dispatch is unavailable', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    const service = new ControlPlaneService(repository, () => now, ids, {
      requestStart: async () => {
        throw new Error('Trigger unavailable');
      },
      requestApprovalResume: async () => {
        throw new Error('Trigger unavailable');
      },
    });
    await expect(
      service.createFeatureRun('request-1', {
        projectId: 'project-1',
        title: 'Status',
        description: 'Add it.',
        repositorySha: 'a'.repeat(40),
        configDigest: 'config',
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
      }),
    ).resolves.toMatchObject({ status: 'pending' });
    await expect(
      repository.listRuns({ status: 'pending' }),
    ).resolves.toHaveLength(1);
  });

  it('signals cancellation only after the atomic cancellation event is durable', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'run-1');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
    const outbox = new FakeOutbox();
    const service = new ControlPlaneService(repository, () => now, ids, outbox);

    await service.cancelRun('run-1', 'cancel-1');

    await expect(repository.listEvents(runId)).resolves.toEqual([
      expect.objectContaining({ type: 'run.cancelled' }),
    ]);
    expect([...outbox.cancellations.values()]).toEqual([
      expect.objectContaining({ runId: 'run-1' }),
    ]);
  });
});
