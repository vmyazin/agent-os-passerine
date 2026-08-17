import { InMemoryDomainRepository } from '@agentos/adapters';
import { persistenceId, isoTimestamp } from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { ControlPlaneService, ServiceError } from './control-plane-service';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');
const ids = (kind: string, key: string) =>
  persistenceId(kind as never, `${kind}-${key}`);
const createService = (repository: InMemoryDomainRepository) =>
  new ControlPlaneService(repository, () => now, ids);

const feature = {
  projectId: 'project-1',
  title: 'Ship approval inbox',
  description: 'Add scoped approvals.',
  repositorySha: 'a'.repeat(40),
  configDigest: 'cfg',
  modelDigest: 'model',
  promptDigest: 'prompt',
  environmentDigest: 'env',
  policyDigest: 'policy',
};

describe('ControlPlaneService', () => {
  it('creates a feature idempotently across service restarts', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });

    const first = await createService(repository).createFeatureRun(
      'feature-key',
      feature,
    );
    const replay = await createService(repository).createFeatureRun(
      'feature-key',
      feature,
    );

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      pipeline: 'feature',
      repositorySha: 'a'.repeat(40),
    });
  });

  it('rejects reuse of an idempotency key with another payload', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    const service = createService(repository);
    await service.createFeatureRun('same-key', feature);

    await expect(
      service.createFeatureRun('same-key', { ...feature, title: 'Different' }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('redacts secrets and hidden reasoning from run projections', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: persistenceId('run', 'run-secret'),
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'failed',
      input: {
        apiToken: 's3cr3t-value',
        title: 'Visible',
        chainOfThought: 'hidden',
      },
      error: { message: 'safe', stack: 'private stack' },
      createdAt: now,
      updatedAt: now,
    });

    const projection = await createService(repository).getRun('run-secret');
    expect(JSON.stringify(projection)).not.toContain('s3cr3t-value');
    expect(JSON.stringify(projection)).not.toContain('hidden');
    expect(JSON.stringify(projection)).not.toContain('private stack');
    expect(JSON.stringify(projection)).toContain('Visible');
  });

  it('replays scoped approval creation after a service restart', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'approval-run');
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
    const expiresAt = isoTimestamp('2026-08-18T12:00:00.000Z');
    const first = await createService(repository).createApproval(
      'approval-key',
      {
        runId,
        scope: 'merge:pull-request:42',
        expiresAt,
      },
    );
    const restarted = new ControlPlaneService(
      repository,
      () => isoTimestamp('2026-08-17T12:05:00.000Z'),
      ids,
    );

    await expect(
      restarted.createApproval('approval-key', {
        runId,
        scope: 'merge:pull-request:42',
        expiresAt,
      }),
    ).resolves.toEqual(first);
  });

  it('records a rejected approval as a sanitized domain event', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'rejected-run');
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
      id: persistenceId('approval', 'reject-me'),
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash',
      status: 'pending',
      createdAt: now,
      expiresAt: isoTimestamp('2026-08-18T12:00:00.000Z'),
    });

    await createService(repository).consumeApproval(
      'reject-me',
      'reject',
      'decision-key',
    );

    const events = await repository.listEvents(runId);
    expect(events[0]?.type).toBe('approval.rejected');
  });

  it('rejects a reused inbox idempotency key before mutating another item', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'inbox-run');
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
    for (const id of ['question-1', 'question-2']) {
      await repository.createInboxMessage({
        id: persistenceId('inboxMessage', id),
        runId,
        status: 'pending',
        body: { question: id },
        createdAt: now,
      });
    }
    const service = createService(repository);
    await service.replyInbox('question-1', 'first', 'reply-key');

    await expect(
      service.replyInbox('question-2', 'second', 'reply-key'),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      repository.getInboxMessage(persistenceId('inboxMessage', 'question-2')),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('does not record a second approval decision under another key', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'single-decision-run');
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
      id: persistenceId('approval', 'single-decision'),
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash',
      status: 'pending',
      createdAt: now,
      expiresAt: isoTimestamp('2026-08-18T12:00:00.000Z'),
    });
    const service = createService(repository);
    await service.consumeApproval('single-decision', 'approve', 'approve-key');

    await expect(
      service.consumeApproval('single-decision', 'reject', 'reject-key'),
    ).rejects.toMatchObject({ code: 'approval_already_decided' });
    await expect(repository.listEvents(runId)).resolves.toHaveLength(1);
  });
});
