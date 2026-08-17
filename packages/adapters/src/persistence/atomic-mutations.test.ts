import { describe, expect, it } from 'vitest';

import { isoTimestamp, persistenceId } from '@agentos/core';
import type { DomainEventDraft } from '@agentos/core';

import {
  EventFingerprintConflictError,
  IdempotencyConflictError,
  InMemoryDomainRepository,
} from './in-memory.js';

const at = isoTimestamp('2026-08-17T12:00:00.000Z');
const later = isoTimestamp('2026-08-17T12:01:00.000Z');
const runId = persistenceId('run', 'atomic-run');

async function seededRepository(
  failBeforeCommit?: (operation: string) => void,
) {
  const repository = new InMemoryDomainRepository(failBeforeCommit);
  const projectId = persistenceId('project', 'atomic-project');
  await repository.createProject({
    id: projectId,
    name: 'Atomic test',
    createdAt: at,
    updatedAt: at,
  });
  await repository.createRun({
    id: runId,
    projectId,
    pipeline: 'feature',
    status: 'waiting',
    createdAt: at,
    updatedAt: at,
  });
  return repository;
}

function event(id: string, type: string, fingerprint = `sha256:${id}`) {
  return {
    runId,
    eventId: persistenceId('event', id),
    fingerprint,
    type,
    occurredAt: later,
  } satisfies DomainEventDraft;
}

describe('atomic mutation outbox contract', () => {
  it('atomically records and replays an immutable configuration revision', async () => {
    const repository = new InMemoryDomainRepository();
    const project = {
      id: persistenceId('project', 'configuration-project'),
      name: 'Configuration Project',
      createdAt: at,
      updatedAt: at,
    };
    const revision = {
      id: persistenceId('configRevision', 'configuration-revision'),
      projectId: project.id,
      config: { version: 1 },
      configDigest: 'config',
      modelDigest: 'model',
      promptDigest: 'prompt',
      environmentDigest: 'environment',
      policyDigest: 'policy',
      repositorySha: '0'.repeat(40),
      createdAt: at,
    } as const;

    const first = await repository.applyConfigRevision(project, revision);
    const replay = await repository.applyConfigRevision(project, revision);

    expect(replay).toEqual(first);
    expect(first.revision).toBe(1);
    await expect(repository.listConfigRevisions(project.id)).resolves.toEqual([
      first,
    ]);
    await expect(
      repository.applyConfigRevision(project, {
        ...revision,
        configDigest: 'changed',
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('atomically replays concurrent run creation and rejects changed payloads', async () => {
    const repository = await seededRepository();
    const candidate = {
      id: persistenceId('run', 'idempotent-run'),
      projectId: persistenceId('project', 'atomic-project'),
      pipeline: 'feature',
      status: 'pending' as const,
      input: { title: 'same' },
      createdAt: at,
      updatedAt: at,
    };

    const [first, replay] = await Promise.all([
      repository.createRunIdempotently(candidate, 'sha256:same'),
      repository.createRunIdempotently(candidate, 'sha256:same'),
    ]);
    expect(replay).toEqual(first);
    await expect(
      repository.createRunIdempotently(
        { ...candidate, input: { title: 'changed' } },
        'sha256:changed',
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('rolls back cancel and its event together, then safely retries', async () => {
    let fail = true;
    const repository = await seededRepository((operation) => {
      if (operation === 'cancelRunWithEvent' && fail) {
        fail = false;
        throw new Error('injected failure before commit');
      }
    });
    const draft = event('cancel-event', 'run.cancelled');

    await expect(
      repository.cancelRunWithEvent(
        runId,
        { status: 'cancelled', updatedAt: later, completedAt: later },
        draft,
      ),
    ).rejects.toThrow('injected failure');
    await expect(repository.getRun(runId)).resolves.toMatchObject({
      status: 'waiting',
    });
    await expect(
      repository.getEvent(runId, draft.eventId),
    ).resolves.toBeUndefined();

    await expect(
      repository.cancelRunWithEvent(
        runId,
        { status: 'cancelled', updatedAt: later, completedAt: later },
        draft,
      ),
    ).resolves.toMatchObject({ status: 'cancelled' });
    await expect(
      repository.getEvent(runId, draft.eventId),
    ).resolves.toMatchObject({ sequence: 1, type: 'run.cancelled' });
  });

  it('rolls back approval consumption and its event together, then safely retries', async () => {
    let fail = true;
    const repository = await seededRepository((operation) => {
      if (operation === 'consumeApprovalWithEvent' && fail) {
        fail = false;
        throw new Error('injected failure before commit');
      }
    });
    const approvalId = persistenceId('approval', 'atomic-approval');
    await repository.createApproval({
      id: approvalId,
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash',
      status: 'pending',
      createdAt: at,
      expiresAt: isoTimestamp('2026-08-18T12:00:00.000Z'),
    });
    const request = {
      approvalId,
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash',
      consumedAt: later,
    } as const;
    const draft = event('approval-event', 'approval.approved');

    await expect(
      repository.consumeApprovalWithEvent(request, draft),
    ).rejects.toThrow('injected failure');
    await expect(repository.getApproval(approvalId)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(
      repository.getEvent(runId, draft.eventId),
    ).resolves.toBeUndefined();

    await expect(
      repository.consumeApprovalWithEvent(request, draft),
    ).resolves.toMatchObject({ status: 'consumed' });
    await expect(
      repository.getEvent(runId, draft.eventId),
    ).resolves.toMatchObject({ sequence: 1, type: 'approval.approved' });
  });

  it('rolls back inbox reply and its event together, then safely retries', async () => {
    let fail = true;
    const repository = await seededRepository((operation) => {
      if (operation === 'replyInboxMessageWithEvent' && fail) {
        fail = false;
        throw new Error('injected failure before commit');
      }
    });
    const messageId = persistenceId('inboxMessage', 'atomic-message');
    await repository.createInboxMessage({
      id: messageId,
      runId,
      status: 'pending',
      body: { question: 'Proceed?' },
      createdAt: at,
    });
    const request = {
      messageId,
      reply: { answer: 'yes' },
      repliedAt: later,
    } as const;
    const draft = event('reply-event', 'inbox.replied');

    await expect(
      repository.replyInboxMessageWithEvent(request, draft),
    ).rejects.toThrow('injected failure');
    await expect(repository.getInboxMessage(messageId)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(
      repository.getEvent(runId, draft.eventId),
    ).resolves.toBeUndefined();

    await expect(
      repository.replyInboxMessageWithEvent(request, draft),
    ).resolves.toMatchObject({ status: 'replied', reply: { answer: 'yes' } });
    await expect(
      repository.getEvent(runId, draft.eventId),
    ).resolves.toMatchObject({ sequence: 1, type: 'inbox.replied' });
  });

  it('allocates sequences and resolves replay directly beyond the first 1,000 events', async () => {
    const repository = await seededRepository();
    let last;
    for (let index = 0; index < 1_005; index += 1) {
      last = await repository.appendEvent(
        event(`event-${String(index)}`, 'run.updated'),
      );
    }
    expect(last?.sequence).toBe(1_005);

    // Use the actual event ID after the list boundary, not a paged lookup.
    const existing = event('event-1002', 'run.updated');
    await expect(repository.appendEvent(existing)).resolves.toMatchObject({
      sequence: 1_003,
    });
    await expect(
      repository.appendEvent({ ...existing, fingerprint: 'sha256:changed' }),
    ).rejects.toBeInstanceOf(EventFingerprintConflictError);
    await expect(
      repository.getEvent(runId, existing.eventId),
    ).resolves.toMatchObject({ sequence: 1_003 });
  });
});
