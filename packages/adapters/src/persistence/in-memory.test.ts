import { describe, expect, it } from 'vitest';

import { isoTimestamp, persistenceId } from '@agentos/core';
import type {
  Approval,
  ConfigRevision,
  DomainEvent,
  GoalCriterion,
  IsoTimestamp,
  Project,
  ProjectSource,
  WorkflowRun,
} from '@agentos/core';

import {
  EventFingerprintConflictError,
  InMemoryDomainRepository,
} from './in-memory.js';
import { IdempotencyConflictError } from './errors.js';

const projectId = persistenceId('project', 'project-1');
const configRevisionId = persistenceId('configRevision', 'config-1');
const runId = persistenceId('run', 'run-1');
const stepRunId = persistenceId('stepRun', 'step-1');
const eventId = persistenceId('event', 'event-1');
const approvalId = persistenceId('approval', 'approval-1');
const inboxMessageId = persistenceId('inboxMessage', 'message-1');
const usageId = persistenceId('usage', 'usage-1');
const webhookDeliveryId = persistenceId('webhookDelivery', 'delivery-1');
const snapshotId = persistenceId('configSnapshot', 'snapshot-1');
const externalSessionId = persistenceId('externalSession', 'session-1');
const artifactId = persistenceId('artifact', 'artifact-1');
const criterionId = persistenceId('goalCriterion', 'criterion-1');
const progressId = persistenceId('goalProgress', 'progress-1');

const project: Project = {
  id: projectId,
  name: 'Passerine',
  repository: 'https://example.com/acme/passerine.git',
  createdAt: isoTimestamp('2026-08-16T12:00:00.000Z'),
  updatedAt: isoTimestamp('2026-08-16T12:00:00.000Z'),
};

const revision: ConfigRevision = {
  id: configRevisionId,
  projectId: project.id,
  revision: 1,
  config: { pipeline: { steps: ['implement'] } },
  configDigest: 'sha256:config',
  modelDigest: 'sha256:model',
  promptDigest: 'sha256:prompt',
  environmentDigest: 'sha256:environment',
  policyDigest: 'sha256:policy',
  repositorySha: '0123456789abcdef',
  createdAt: isoTimestamp('2026-08-16T12:01:00.000Z'),
};

const run: WorkflowRun = {
  id: runId,
  projectId: project.id,
  configRevisionId: revision.id,
  pipeline: 'feature',
  status: 'pending',
  input: { issue: 42 },
  createdAt: isoTimestamp('2026-08-16T12:02:00.000Z'),
  updatedAt: isoTimestamp('2026-08-16T12:02:00.000Z'),
};

async function seededRepository(): Promise<InMemoryDomainRepository> {
  const repository = new InMemoryDomainRepository();
  await repository.createProject(project);
  await repository.createConfigRevision(revision);
  await repository.createRun(run);
  return repository;
}

describe('InMemoryDomainRepository', () => {
  it('atomically imports one exact source and converges duplicate imports', async () => {
    const repository = new InMemoryDomainRepository();
    const source: ProjectSource = {
      kind: 'local',
      projectId: project.id,
      sourceKey: 'local:/workspaces/passerine',
      localPath: '/workspaces/passerine',
      defaultBranch: 'main',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };

    await expect(
      repository.getProjectSource(project.id),
    ).resolves.toBeUndefined();
    await expect(
      repository.getProjectSourceByKey(source.sourceKey),
    ).resolves.toBeUndefined();

    const first = await repository.importProjectSource(project, source);
    expect(first).toEqual({ project, source, created: true });
    await expect(repository.getProject(project.id)).resolves.toEqual(project);
    await expect(repository.getProjectSource(project.id)).resolves.toEqual(
      source,
    );
    await expect(
      repository.getProjectSourceByKey(source.sourceKey),
    ).resolves.toEqual(source);

    const replay = await repository.importProjectSource(
      { ...project, name: 'ignored replay name' },
      { ...source, updatedAt: isoTimestamp('2026-08-16T12:05:00.000Z') },
    );
    expect(replay).toEqual({ project, source, created: false });
  });

  it('rejects reusing an import idempotency key for another source', async () => {
    const repository = new InMemoryDomainRepository();
    const source: ProjectSource = {
      kind: 'local',
      projectId: project.id,
      sourceKey: 'local:/workspaces/passerine',
      localPath: '/workspaces/passerine',
      defaultBranch: 'main',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    await repository.importProjectSource(project, source, {
      idempotencyKey: 'import-1',
      fingerprint: 'fingerprint-a',
    });
    const other = { ...project, id: persistenceId('project', 'project-other') };

    await expect(
      repository.importProjectSource(
        other,
        {
          ...source,
          projectId: other.id,
          sourceKey: 'local:/workspaces/other',
          localPath: '/workspaces/other',
        },
        { idempotencyKey: 'import-1', fingerprint: 'fingerprint-b' },
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('attaches an imported source to a matching existing project', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject(project);
    const source: ProjectSource = {
      kind: 'github',
      projectId: project.id,
      sourceKey: 'github:acme/passerine',
      repositoryUrl: 'https://github.com/acme/passerine',
      owner: 'acme',
      name: 'passerine',
      repositoryId: 42,
      readerInstallationId: 7,
      defaultBranch: 'main',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };

    await expect(
      repository.importProjectSource(project, source),
    ).resolves.toEqual({
      project,
      source,
      created: false,
    });
  });

  it('rejects a changed immutable GitHub identity for an existing source key', async () => {
    const repository = new InMemoryDomainRepository();
    const source: ProjectSource = {
      kind: 'github',
      projectId: project.id,
      sourceKey: 'github:acme/passerine',
      repositoryUrl: 'https://github.com/acme/passerine',
      owner: 'acme',
      name: 'passerine',
      repositoryId: 42,
      readerInstallationId: 7,
      defaultBranch: 'main',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    await repository.importProjectSource(project, source);

    await expect(
      repository.importProjectSource(project, {
        ...source,
        repositoryId: 43,
      }),
    ).rejects.toMatchObject({ name: 'ProjectSourceIdentityConflictError' });
  });

  it('rejects attaching one GitHub repository id under another source key', async () => {
    const repository = new InMemoryDomainRepository();
    const source: ProjectSource = {
      kind: 'github',
      projectId: project.id,
      sourceKey: 'github:acme/passerine',
      repositoryUrl: 'https://github.com/acme/passerine',
      owner: 'acme',
      name: 'passerine',
      repositoryId: 42,
      readerInstallationId: 7,
      defaultBranch: 'main',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    await repository.importProjectSource(project, source);
    const renamedProject = {
      ...project,
      id: persistenceId('project', 'renamed-project'),
    };

    await expect(
      repository.importProjectSource(renamedProject, {
        ...source,
        projectId: renamedProject.id,
        sourceKey: 'github:acme/renamed',
        repositoryUrl: 'https://github.com/acme/renamed',
        name: 'renamed',
      }),
    ).rejects.toMatchObject({ name: 'ProjectSourceIdentityConflictError' });
  });

  it('returns the canonical existing project when a source key races with another id', async () => {
    const repository = new InMemoryDomainRepository();
    const source: ProjectSource = {
      kind: 'local',
      projectId: project.id,
      sourceKey: 'local:/workspaces/passerine',
      localPath: '/workspaces/passerine',
      defaultBranch: 'main',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    await repository.importProjectSource(project, source);
    const other = {
      ...project,
      id: persistenceId('project', 'project-other'),
      name: 'Other',
    };

    await expect(
      repository.importProjectSource(other, { ...source, projectId: other.id }),
    ).resolves.toEqual({ project, source, created: false });
  });

  it('creates, gets, lists, and updates runs using defensive copies', async () => {
    const repository = await seededRepository();
    const persistedRun = { ...run, stateVersion: 0 };

    const fetched = await repository.getRun(run.id);
    expect(fetched).toEqual(persistedRun);
    if (fetched === undefined) throw new Error('missing run fixture');
    (fetched.input as { issue: number }).issue = 999;

    expect((await repository.getRun(run.id))?.input).toEqual({ issue: 42 });
    expect(await repository.listRuns({ projectId: project.id })).toEqual([
      persistedRun,
    ]);

    const updated = await repository.updateRun(run.id, {
      status: 'running',
      updatedAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
    });
    expect(updated.status).toBe('running');
  });

  it('lists runs newest first when order is desc and refuses desc cursors', async () => {
    const repository = await seededRepository();
    const later = {
      ...run,
      id: persistenceId('run', 'run_order_later'),
      createdAt: isoTimestamp('2026-08-16T12:05:00.000Z'),
      updatedAt: isoTimestamp('2026-08-16T12:05:00.000Z'),
    };
    await repository.createRun(later);

    const ascending = await repository.listRuns({});
    expect(ascending.map((entry) => entry.id)).toEqual([run.id, later.id]);
    const descending = await repository.listRuns({ order: 'desc' });
    expect(descending.map((entry) => entry.id)).toEqual([later.id, run.id]);
    // A descending window of one returns the newest run, not the oldest.
    const newest = await repository.listRuns({ order: 'desc', limit: 1 });
    expect(newest.map((entry) => entry.id)).toEqual([later.id]);

    await expect(
      repository.listRuns({
        order: 'desc',
        after: { at: run.createdAt, id: run.id },
      }),
    ).rejects.toThrow('descending run listing does not support cursors');
  });

  it('rejects invalid timestamps even if a caller bypasses the type brand', async () => {
    const repository = new InMemoryDomainRepository();
    await expect(
      repository.createProject({
        ...project,
        id: persistenceId('project', 'invalid-time-project'),
        createdAt: 'tomorrow' as IsoTimestamp,
      }),
    ).rejects.toThrow('timestamp must be an ISO 8601 string');
  });

  it('idempotently upserts a step by run, step key, and attempt', async () => {
    const repository = await seededRepository();
    const first = await repository.upsertStepRun({
      id: stepRunId,
      runId: run.id,
      stepKey: 'implement',
      attempt: 1,
      status: 'running',
      input: { task: 'ship' },
      createdAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
      updatedAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
    });
    const second = await repository.upsertStepRun({
      ...first,
      id: persistenceId(
        'stepRun',
        'a-different-id-is-ignored-for-the-idempotency-key',
      ),
      status: 'succeeded',
      output: { result: 'done' },
      createdAt: isoTimestamp('2026-08-16T12:03:30.000Z'),
      updatedAt: isoTimestamp('2026-08-16T12:04:00.000Z'),
    });

    expect(second.id).toBe(stepRunId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.status).toBe('succeeded');
    expect(await repository.listStepRuns(run.id)).toHaveLength(1);
  });

  it('deduplicates matching events and rejects event id fingerprint conflicts', async () => {
    const repository = await seededRepository();
    const event: DomainEvent = {
      runId: run.id,
      eventId,
      fingerprint: 'sha256:event-one',
      sequence: 1,
      type: 'run.started',
      payload: { actor: 'scheduler' },
      occurredAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
    };

    expect(await repository.appendEvent(event)).toEqual(event);
    expect(await repository.appendEvent(structuredClone(event))).toEqual(event);
    await expect(
      repository.appendEvent({ ...event, fingerprint: 'sha256:different' }),
    ).rejects.toBeInstanceOf(EventFingerprintConflictError);
    expect(await repository.listEvents(run.id)).toEqual([event]);
  });

  it('allocates the next sequence instead of accepting a caller sequence', async () => {
    const repository = await seededRepository();
    await repository.appendEvent({
      runId: run.id,
      eventId,
      fingerprint: 'sha256:event-one',
      type: 'run.started',
      occurredAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
    });

    await expect(
      repository.appendEvent({
        runId: run.id,
        eventId: persistenceId('event', 'event-2'),
        fingerprint: 'sha256:event-two',
        type: 'run.updated',
        occurredAt: isoTimestamp('2026-08-16T12:04:00.000Z'),
      }),
    ).resolves.toMatchObject({ sequence: 2 });
  });

  it('consumes only a matching, pending, unexpired approval once', async () => {
    const repository = await seededRepository();
    const approval: Approval = {
      id: approvalId,
      runId: run.id,
      scope: 'publish:repository/acme/passerine',
      fingerprint: 'sha256:approval',
      status: 'pending',
      createdAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
      expiresAt: isoTimestamp('2026-08-16T13:03:00.000Z'),
    };
    await repository.createApproval(approval);

    expect(
      await repository.consumeApproval({
        approvalId: approval.id,
        runId: run.id,
        scope: approval.scope,
        fingerprint: 'sha256:another-action',
        consumedAt: isoTimestamp('2026-08-16T12:09:00.000Z'),
      }),
    ).toBeUndefined();
    expect(
      await repository.consumeApproval({
        approvalId: approval.id,
        runId: run.id,
        scope: approval.scope,
        fingerprint: approval.fingerprint,
        consumedAt: isoTimestamp('2026-08-16T12:10:00.000Z'),
      }),
    ).toMatchObject({ status: 'consumed' });
    expect(
      await repository.consumeApproval({
        approvalId: approval.id,
        runId: run.id,
        scope: approval.scope,
        fingerprint: approval.fingerprint,
        consumedAt: isoTimestamp('2026-08-16T12:11:00.000Z'),
      }),
    ).toBeUndefined();
  });

  it('compares approval expiry and consumption as instants', async () => {
    const repository = await seededRepository();
    const offsetApprovalId = persistenceId('approval', 'approval-offset');
    await repository.createApproval({
      id: offsetApprovalId,
      runId: run.id,
      scope: 'publish:offset-test',
      fingerprint: 'sha256:offset-approval',
      status: 'pending',
      createdAt: isoTimestamp('2026-08-16T11:00:00-07:00'),
      expiresAt: isoTimestamp('2026-08-16T12:00:00-07:00'),
    });

    expect(
      await repository.consumeApproval({
        approvalId: offsetApprovalId,
        runId: run.id,
        scope: 'publish:offset-test',
        fingerprint: 'sha256:offset-approval',
        consumedAt: isoTimestamp('2026-08-16T18:30:00.000Z'),
      }),
    ).toMatchObject({ status: 'consumed' });
  });

  it('preserves microsecond precision when checking approval expiry', async () => {
    const repository = await seededRepository();
    const preciseApprovalId = persistenceId('approval', 'approval-precise');
    await repository.createApproval({
      id: preciseApprovalId,
      runId: run.id,
      scope: 'publish:precise-test',
      fingerprint: 'sha256:precise-approval',
      status: 'pending',
      createdAt: isoTimestamp('2026-08-16T12:00:00.000000Z'),
      expiresAt: isoTimestamp('2026-08-16T12:00:00.123999Z'),
    });

    expect(
      await repository.consumeApproval({
        approvalId: preciseApprovalId,
        runId: run.id,
        scope: 'publish:precise-test',
        fingerprint: 'sha256:precise-approval',
        consumedAt: isoTimestamp('2026-08-16T12:00:00.123456Z'),
      }),
    ).toMatchObject({ status: 'consumed' });
  });

  it('creates and replies to inbox messages exactly once', async () => {
    const repository = await seededRepository();
    await repository.createInboxMessage({
      id: inboxMessageId,
      runId: run.id,
      status: 'pending',
      body: { question: 'Proceed?' },
      createdAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
    });

    const replied = await repository.replyInboxMessage({
      messageId: inboxMessageId,
      reply: { answer: 'yes' },
      repliedAt: isoTimestamp('2026-08-16T12:04:00.000Z'),
    });
    expect(replied).toMatchObject({
      status: 'replied',
      reply: { answer: 'yes' },
    });
    await expect(
      repository.replyInboxMessage({
        messageId: inboxMessageId,
        reply: { answer: 'again' },
        repliedAt: isoTimestamp('2026-08-16T12:05:00.000Z'),
      }),
    ).rejects.toThrow('already replied');
  });

  it('deduplicates usage and webhook receipts by their idempotency keys', async () => {
    const repository = await seededRepository();
    const usage = {
      idempotencyId: usageId,
      runId: run.id,
      model: 'openai/test-model',
      pricingVersion: 'pricing-v1',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      runtimeMs: 500,
      microdollars: 123,
      recordedAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
    };
    expect(await repository.appendUsage(usage)).toEqual(usage);
    expect(await repository.appendUsage(structuredClone(usage))).toEqual(usage);
    expect(await repository.listUsage(run.id)).toEqual([usage]);

    const receipt = {
      source: 'github',
      deliveryId: webhookDeliveryId,
      fingerprint: 'sha256:webhook',
      receivedAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
      expiresAt: isoTimestamp('2026-08-23T12:03:00.000Z'),
    };
    expect(await repository.claimWebhook(receipt)).toMatchObject({
      claimed: true,
    });
    expect(await repository.claimWebhook(receipt)).toMatchObject({
      claimed: false,
    });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects non-safe-integer microdollar usage values: %s',
    async (microdollars) => {
      const repository = await seededRepository();
      await expect(
        repository.appendUsage({
          idempotencyId: persistenceId(
            'usage',
            `usage-${String(microdollars)}`,
          ),
          runId: run.id,
          model: 'openai/test-model',
          pricingVersion: 'pricing-v1',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
          runtimeMs: 0,
          microdollars,
          recordedAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
        }),
      ).rejects.toThrow('microdollars must be a non-negative safe integer');
    },
  );

  it('persists config snapshots, sessions, artifacts, goals, and progress', async () => {
    const repository = await seededRepository();
    await repository.createConfigSnapshot({
      id: snapshotId,
      runId: run.id,
      configRevisionId: revision.id,
      config: revision.config,
      configDigest: revision.configDigest,
      modelDigest: revision.modelDigest,
      promptDigest: revision.promptDigest,
      environmentDigest: revision.environmentDigest,
      policyDigest: revision.policyDigest,
      repositorySha: revision.repositorySha,
      createdAt: isoTimestamp('2026-08-16T12:02:00.000Z'),
    });
    await repository.createExternalSession({
      id: externalSessionId,
      runId: run.id,
      provider: 'test-runtime',
      externalId: 'remote-1',
      status: 'active',
      createdAt: isoTimestamp('2026-08-16T12:03:00.000Z'),
    });
    await repository.createArtifact({
      id: artifactId,
      runId: run.id,
      key: 'runs/run-1/output.json',
      digest: 'sha256:artifact',
      createdAt: isoTimestamp('2026-08-16T12:04:00.000Z'),
    });
    const criterion: GoalCriterion = {
      id: criterionId,
      runId: run.id,
      ordinal: 0,
      description: 'All tests pass',
      definition: {
        id: 'tests',
        type: 'command',
        description: 'All tests pass',
        command: 'pnpm test',
      },
      status: 'pending',
      createdAt: isoTimestamp('2026-08-16T12:02:00.000Z'),
    };
    await repository.createGoalCriterion(criterion);
    await repository.appendGoalProgress({
      id: progressId,
      runId: run.id,
      criterionId: criterion.id,
      step: 1,
      status: 'satisfied',
      detail: 'Verified by CI',
      recordedAt: isoTimestamp('2026-08-16T12:05:00.000Z'),
    });

    expect(await repository.getConfigSnapshot(snapshotId)).toMatchObject({
      repositorySha: revision.repositorySha,
    });
    expect(await repository.listExternalSessions(run.id)).toHaveLength(1);
    expect(await repository.listArtifacts(run.id)).toHaveLength(1);
    expect(await repository.listGoalCriteria(run.id)).toEqual([criterion]);
    expect(await repository.listGoalProgress(run.id)).toHaveLength(1);
  });

  it('normalizes a goal criterion ordinal collision as an idempotency conflict', async () => {
    const repository = await seededRepository();
    const criterion: GoalCriterion = {
      id: criterionId,
      runId: run.id,
      ordinal: 0,
      description: 'All tests pass',
      definition: {
        id: 'tests',
        type: 'command',
        description: 'All tests pass',
        command: 'pnpm test',
      },
      status: 'pending',
      createdAt: isoTimestamp('2026-08-16T12:02:00.000Z'),
    };
    await repository.createGoalCriterionIdempotently(criterion);

    await expect(
      repository.createGoalCriterionIdempotently({
        ...criterion,
        id: persistenceId('goalCriterion', 'criterion-2'),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
