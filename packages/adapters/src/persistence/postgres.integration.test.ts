import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  isoTimestamp,
  isoTimestampEpochMicroseconds,
  persistenceId,
} from '@agentos/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EventFingerprintConflictError,
  IdempotencyConflictError,
  StaleConfigurationError,
} from './errors.js';
import { createDomainArtifactManifestStore } from '../artifacts/manifest.js';
import { createPostgresPublicationStoreForTest } from '../github/postgres-store.js';
import { createPostgresWorkflowCheckpointStoreForTest } from '../trigger/postgres-checkpoint-store.js';
import { NeonDomainRepository } from './neon-repository.js';
import { repositoryParityContract } from './repository-parity-contract.js';
import * as schema from './schema.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const migrationDirectory = resolve(process.cwd(), '../../drizzle');

describePostgres('PostgreSQL persistence integration', () => {
  const schemaName = `agentos_${randomUUID().replaceAll('-', '')}`;
  let admin: Sql;
  let client: Sql;
  let repository: NeonDomainRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined)
      throw new Error('TEST_DATABASE_URL required');
    admin = postgres(databaseUrl, { max: 1 });
    await admin.unsafe(`create schema "${schemaName}"`);
    await admin.unsafe(`set search_path to "${schemaName}"`);

    for (const filename of readdirSync(migrationDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const migration = readFileSync(
        resolve(migrationDirectory, filename),
        'utf8',
      )
        .replaceAll('"public".', `"${schemaName}".`)
        .split('--> statement-breakpoint');
      for (const statement of migration) {
        if (statement.trim() !== '') await admin.unsafe(statement);
      }
    }

    client = postgres(databaseUrl, {
      max: 10,
      connection: { search_path: schemaName },
    });
    repository = new NeonDomainRepository(drizzle(client, { schema }) as never);
  }, 30_000);

  afterAll(async () => {
    if (client !== undefined) await client.end();
    if (admin !== undefined) {
      if (!/^agentos_[a-f0-9]{32}$/.test(schemaName)) {
        throw new Error('refusing to remove unexpected integration schema');
      }
      await admin.unsafe(`drop schema "${schemaName}" cascade`);
      await admin.end();
    }
  });

  repositoryParityContract('postgresql', () => repository);

  it('atomically checkpoints effects and enforces durable workflow admission', async () => {
    const suffix = randomUUID();
    const at = isoTimestamp('2026-08-17T12:00:00.000Z');
    const projectId = persistenceId('project', `workflow-project-${suffix}`);
    const runId = persistenceId('run', `workflow-run-${suffix}`);
    await repository.createProject({
      id: projectId,
      name: 'Workflow integration',
      createdAt: at,
      updatedAt: at,
    });
    await repository.createRun({
      id: runId,
      projectId,
      pipeline: 'feature',
      status: 'running',
      createdAt: at,
      updatedAt: at,
    });
    const store = createPostgresWorkflowCheckpointStoreForTest({
      execute: async (query, parameters) =>
        (await client.unsafe(query, [
          ...parameters,
        ] as never[])) as unknown as readonly Readonly<
          Record<string, unknown>
        >[],
    });
    const effect = {
      key: `runtime:${suffix}`,
      runId,
      kind: 'runtime-session',
      inputFingerprint: 'a'.repeat(64),
      createdAt: at,
      updatedAt: at,
    };
    await expect(store.claimEffect(effect)).resolves.toMatchObject({
      status: 'pending',
    });
    await store.markEffectStarted(effect.key, at);
    await store.attachExternalRef(effect.key, 'session-safe-ref', at);
    await expect(
      store.completeEffect(effect.key, { ok: true }, at),
    ).resolves.toMatchObject({
      status: 'succeeded',
      externalRef: 'session-safe-ref',
    });
    await expect(
      store.admitSession({
        runId,
        stepKey: 'specification',
        workflowSpentMicrodollars: 0,
        dailySpentMicrodollars: 0,
        workflowLimitMicrodollars: 2_000_000,
        dailyLimitMicrodollars: 5_000_000,
        admissionNumerator: 80,
        admissionDenominator: 100,
        now: at,
        leaseExpiresAt: isoTimestamp('2026-08-17T12:21:00.000Z'),
      }),
    ).resolves.toEqual({ admitted: true });
  });

  it('allows exactly one concurrent configuration apply for an expected active revision', async () => {
    const suffix = randomUUID();
    const at = isoTimestamp('2026-08-17T12:00:00.123456Z');
    const current = await repository.getLatestConfigRevision();
    const currentProject =
      current === undefined
        ? undefined
        : await repository.getProject(current.projectId);
    const project = {
      id:
        currentProject?.id ??
        persistenceId('project', `configuration-${suffix}`),
      name: 'Concurrent configuration',
      createdAt: currentProject?.createdAt ?? at,
      updatedAt: at,
    };
    const draft = (id: string, digest: string, version: number) => ({
      id: persistenceId('configRevision', `${id}-${suffix}`),
      projectId: project.id,
      config: { version },
      configDigest: digest,
      modelDigest: 'model',
      promptDigest: 'prompt',
      environmentDigest: 'environment',
      policyDigest: 'policy',
      repositorySha: '0'.repeat(40),
      createdAt: at,
    });
    const first = await repository.applyConfigRevision(
      project,
      draft('first', 'config-first', 1),
      {
        revision: current?.revision ?? null,
        digest: current?.configDigest ?? null,
      },
    );

    const results = await Promise.allSettled([
      repository.applyConfigRevision(
        project,
        draft('second-a', 'config-second-a', 2),
        { revision: first.revision, digest: first.configDigest },
      ),
      repository.applyConfigRevision(
        project,
        draft('second-b', 'config-second-b', 3),
        { revision: first.revision, digest: first.configDigest },
      ),
    ]);

    expect(
      results.filter((entry) => entry.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.find((entry) => entry.status === 'rejected')).toMatchObject({
      reason: expect.any(StaleConfigurationError),
    });
  });

  it('atomically claims and checkpoints a publication with its append-only event', async () => {
    const { projectId, runId } = await seed(`publication-${randomUUID()}`);
    const store = createPostgresPublicationStoreForTest({
      execute: async (query, parameters) =>
        (await client.unsafe(query, [
          ...parameters,
        ] as never[])) as readonly unknown[],
    });
    const claim = {
      key: createHash('sha256')
        .update(`publication-${randomUUID()}`)
        .digest('hex'),
      bindingKey: createHash('sha256')
        .update(`binding-${randomUUID()}`)
        .digest('hex'),
      projectId,
      runId,
      repositoryId: 314159,
      manifestDigest: 'a'.repeat(64),
      policyDigest: 'b'.repeat(64),
      baseSha: 'c'.repeat(40),
      branch: 'agentos/integration-12345678',
      now: '2026-08-17T12:00:00.000Z',
    } as const;
    const [first, replay] = await Promise.all([
      store.claim(claim),
      store.claim(claim),
    ]);
    expect(replay).toEqual(first);
    const blobs = await store.save(
      claim.key,
      first.revision,
      {
        phase: 'blobs_created',
        blobShas: {},
        updatedAt: '2026-08-17T12:00:00.500Z',
      },
      {
        publicationKey: claim.key,
        phase: 'blobs_created',
        at: '2026-08-17T12:00:00.500Z',
        details: { count: 0 },
      },
    );
    const saved = await store.save(
      claim.key,
      blobs.revision,
      {
        phase: 'tree_created',
        treeSha: 'd'.repeat(40),
        updatedAt: '2026-08-17T12:00:01.000Z',
      },
      {
        publicationKey: claim.key,
        phase: 'tree_created',
        at: '2026-08-17T12:00:01.000Z',
        details: { treeSha: 'd'.repeat(40) },
      },
    );
    expect(saved).toMatchObject({ phase: 'tree_created', revision: 2 });
    expect(
      (await store.listEvents()).filter(
        (event) => event.publicationKey === claim.key,
      ),
    ).toEqual([
      expect.objectContaining({ phase: 'claimed' }),
      expect.objectContaining({ phase: 'blobs_created' }),
      expect.objectContaining({ phase: 'tree_created' }),
    ]);
  });

  async function seed(suffix: string) {
    const projectId = persistenceId('project', `${suffix}-project`);
    const runId = persistenceId('run', `${suffix}-run`);
    const at = isoTimestamp('2026-08-17T12:00:00.123456Z');
    await repository.createProject({
      id: projectId,
      name: suffix,
      createdAt: at,
      updatedAt: at,
    });
    await repository.createRun({
      id: runId,
      projectId,
      pipeline: 'integration',
      status: 'pending',
      createdAt: at,
      updatedAt: at,
    });
    return { projectId, runId, at };
  }

  it('resolves concurrent event replays and allocates independent sequences', async () => {
    const { runId, at } = await seed(`event-${randomUUID()}`);
    const event = {
      runId,
      eventId: persistenceId('event', 'event-replay'),
      fingerprint: 'sha256:event',
      sequence: 1,
      type: 'run.started',
      payload: null,
      occurredAt: at,
    } as const;

    const replayed = await Promise.all([
      repository.appendEvent(event),
      repository.appendEvent(event),
    ]);
    expect(replayed.map((entry) => entry.sequence)).toEqual([1, 1]);
    await expect(
      repository.appendEvent({ ...event, fingerprint: 'sha256:different' }),
    ).rejects.toBeInstanceOf(EventFingerprintConflictError);
    await expect(
      repository.appendEvent({
        ...event,
        eventId: persistenceId('event', 'event-sequence-conflict'),
        fingerprint: 'sha256:sequence',
      }),
    ).resolves.toMatchObject({
      eventId: 'event-sequence-conflict',
      sequence: 2,
    });
  });

  it('atomically replays concurrent run creation and rejects changed payloads', async () => {
    const projectId = persistenceId('project', `run-${randomUUID()}-project`);
    await repository.createProject({
      id: projectId,
      name: 'concurrent run',
      createdAt: isoTimestamp('2026-08-17T12:00:00.000Z'),
      updatedAt: isoTimestamp('2026-08-17T12:00:00.000Z'),
    });
    const run = {
      id: persistenceId('run', `run-${randomUUID()}`),
      projectId,
      pipeline: 'feature',
      status: 'pending' as const,
      input: { title: 'same payload' },
      createdAt: isoTimestamp('2026-08-17T12:00:01.000Z'),
      updatedAt: isoTimestamp('2026-08-17T12:00:01.000Z'),
    };

    const [first, replay] = await Promise.all([
      repository.createRunIdempotently(run, 'sha256:same-run'),
      repository.createRunIdempotently(run, 'sha256:same-run'),
    ]);
    expect(replay).toEqual(first);
    await expect(
      repository.createRunIdempotently(
        { ...run, input: { title: 'changed payload' } },
        'sha256:changed-run',
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('replays concurrent serialized cancel, approval, and inbox mutations', async () => {
    const { runId, at } = await seed(`serialized-${randomUUID()}`);
    const cancelEvent = {
      runId,
      eventId: persistenceId('event', 'serialized-cancel'),
      fingerprint: 'sha256:serialized-cancel',
      type: 'run.cancelled',
      payload: {},
      occurredAt: at,
    } as const;
    const cancelled = await Promise.all([
      repository.cancelRunWithEvent(
        runId,
        { status: 'cancelled', updatedAt: at, completedAt: at },
        cancelEvent,
      ),
      repository.cancelRunWithEvent(
        runId,
        { status: 'cancelled', updatedAt: at, completedAt: at },
        cancelEvent,
      ),
    ]);
    expect(cancelled.map((run) => run.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    await expect(
      repository.cancelRunWithEvent(
        runId,
        { status: 'cancelled', updatedAt: at, completedAt: at },
        { ...cancelEvent, fingerprint: 'sha256:changed' },
      ),
    ).rejects.toBeInstanceOf(EventFingerprintConflictError);

    const approvalId = persistenceId('approval', 'serialized-approval');
    await repository.createApproval({
      id: approvalId,
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash',
      status: 'pending',
      createdAt: at,
      expiresAt: isoTimestamp('2026-08-18T12:00:00.000Z'),
    });
    const approvalRequest = {
      approvalId,
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash',
      consumedAt: at,
    } as const;
    const approvalEvent = {
      runId,
      eventId: persistenceId('event', 'serialized-approval-event'),
      fingerprint: 'sha256:serialized-approval',
      type: 'approval.approved',
      payload: { approvalId },
      occurredAt: at,
    } as const;
    const approvals = await Promise.all([
      repository.consumeApprovalWithEvent(approvalRequest, approvalEvent),
      repository.consumeApprovalWithEvent(approvalRequest, approvalEvent),
    ]);
    expect(approvals.map((approval) => approval?.status)).toEqual([
      'consumed',
      'consumed',
    ]);

    const messageId = persistenceId('inboxMessage', 'serialized-message');
    await repository.createInboxMessage({
      id: messageId,
      runId,
      status: 'pending',
      body: { question: 'Proceed?' },
      createdAt: at,
    });
    const replyRequest = {
      messageId,
      reply: { answer: 'yes' },
      repliedAt: at,
    } as const;
    const replyEvent = {
      runId,
      eventId: persistenceId('event', 'serialized-reply-event'),
      fingerprint: 'sha256:serialized-reply',
      type: 'inbox.replied',
      payload: { messageId },
      occurredAt: at,
    } as const;
    const replies = await Promise.all([
      repository.replyInboxMessageWithEvent(replyRequest, replyEvent),
      repository.replyInboxMessageWithEvent(replyRequest, replyEvent),
    ]);
    expect(replies.map((message) => message.status)).toEqual([
      'replied',
      'replied',
    ]);
  });

  it('resolves concurrent usage replays and rejects changed content', async () => {
    const { runId, at } = await seed(`usage-${randomUUID()}`);
    const usage = {
      idempotencyId: persistenceId('usage', 'usage-concurrent'),
      runId,
      model: 'openai/test',
      inputTokens: 10,
      outputTokens: 20,
      runtimeMs: 30,
      microdollars: 40,
      recordedAt: at,
    } as const;

    await expect(
      Promise.all([
        repository.appendUsage(usage),
        repository.appendUsage(usage),
      ]),
    ).resolves.toHaveLength(2);
    await expect(
      repository.appendUsage({ ...usage, microdollars: 41 }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('grants exactly one concurrent webhook claim without xmax', async () => {
    const receipt = {
      source: `github-${randomUUID()}`,
      deliveryId: persistenceId('webhookDelivery', 'delivery-concurrent'),
      fingerprint: 'sha256:webhook',
      receivedAt: isoTimestamp('2026-08-17T12:00:00.123456Z'),
      expiresAt: isoTimestamp('2026-08-24T12:00:00.123456Z'),
    } as const;

    const claims = await Promise.all([
      repository.claimWebhook(receipt),
      repository.claimWebhook(receipt),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    await expect(
      repository.claimWebhook({ ...receipt, fingerprint: 'sha256:different' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('round-trips JSON null separately from SQL NULL', async () => {
    const { projectId, runId, at } = await seed(`json-${randomUUID()}`);
    const revision = await repository.createConfigRevision({
      id: persistenceId('configRevision', `revision-${randomUUID()}`),
      projectId,
      revision: 1,
      config: null,
      configDigest: 'config',
      modelDigest: 'model',
      promptDigest: 'prompt',
      environmentDigest: 'environment',
      policyDigest: 'policy',
      repositorySha: 'sha',
      createdAt: at,
    });
    expect(revision.config).toBeNull();

    const updated = await repository.updateRun(runId, {
      output: null,
      updatedAt: at,
    });
    expect(updated).toHaveProperty('output', null);
    expect(updated).not.toHaveProperty('error');

    const [storedRevision] = await client<
      readonly {
        configIsSqlNull: boolean;
        configJsonType: string | null;
      }[]
    >`
      select
        config is null as "configIsSqlNull",
        jsonb_typeof(config) as "configJsonType"
      from config_revisions
      where id = ${revision.id}
    `;
    expect(storedRevision).toEqual({
      configIsSqlNull: false,
      configJsonType: 'null',
    });

    const [storedRun] = await client<
      readonly {
        errorIsSqlNull: boolean;
        outputIsSqlNull: boolean;
        outputJsonType: string | null;
      }[]
    >`
      select
        error is null as "errorIsSqlNull",
        output is null as "outputIsSqlNull",
        jsonb_typeof(output) as "outputJsonType"
      from workflow_runs
      where id = ${runId}
    `;
    expect(storedRun).toEqual({
      errorIsSqlNull: true,
      outputIsSqlNull: false,
      outputJsonType: 'null',
    });
  });

  it('preserves microseconds and normalizes offset timestamps through the driver', async () => {
    const input = isoTimestamp('2026-08-17T05:00:00.123456-07:00');
    const project = await repository.createProject({
      id: persistenceId('project', `timestamp-${randomUUID()}`),
      name: 'timestamp-parser',
      createdAt: input,
      updatedAt: input,
    });

    expect(project.createdAt).toBe('2026-08-17T12:00:00.123456Z');
    expect(isoTimestampEpochMicroseconds(project.createdAt)).toBe(
      isoTimestampEpochMicroseconds(input),
    );
  });

  it('upgrades valid pre-0008 manifests without classifying legacy artifacts', async () => {
    if (databaseUrl === undefined)
      throw new Error('TEST_DATABASE_URL required');
    const upgradeSchema = `agentos_${randomUUID().replaceAll('-', '')}`;
    if (!/^agentos_[a-f0-9]{32}$/.test(upgradeSchema))
      throw new Error('invalid upgrade integration schema');
    const upgradeAdmin = postgres(databaseUrl, {
      max: 1,
      connection: { search_path: upgradeSchema },
    });
    await admin.unsafe(`create schema "${upgradeSchema}"`);
    try {
      const migrations = readdirSync(migrationDirectory)
        .filter((name) => name.endsWith('.sql'))
        .sort();
      for (const filename of migrations.filter((name) => name < '0008_')) {
        const statements = readFileSync(
          resolve(migrationDirectory, filename),
          'utf8',
        )
          .replaceAll('"public".', `"${upgradeSchema}".`)
          .split('--> statement-breakpoint');
        for (const statement of statements)
          if (statement.trim() !== '') await upgradeAdmin.unsafe(statement);
      }

      const projectId = `upgrade-project-${randomUUID()}`;
      const runId = `upgrade-run-${randomUUID()}`;
      const stepId = 'specification';
      const artifactId = 'approved-spec';
      const digest = 'a'.repeat(64);
      const logicalKey = `artifact-manifest/v1/${stepId}/${artifactId}/1`;
      const uri = `artifacts/v1/${projectId}/${runId}/${stepId}/${artifactId}/1/sha256/${digest}`;
      const recordId = `artifact_${createHash('sha256')
        .update(`${projectId}\0${runId}\0${logicalKey}`)
        .digest('hex')}`;
      const overMarginDigest = 'b'.repeat(64);
      const overMarginLogicalKey = `artifact-manifest/v1/${stepId}/over-margin/1`;
      const overMarginUri = `artifacts/v1/${projectId}/${runId}/${stepId}/over-margin/1/sha256/${overMarginDigest}`;
      const overMarginRecordId = `artifact_${createHash('sha256')
        .update(`${projectId}\0${runId}\0${overMarginLogicalKey}`)
        .digest('hex')}`;
      await upgradeAdmin`
        insert into projects (id, name, created_at, updated_at)
        values (${projectId}, 'upgrade', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')
      `;
      await upgradeAdmin`
        insert into workflow_runs (id, project_id, pipeline, status, created_at, updated_at)
        values (${runId}, ${projectId}, 'upgrade', 'running', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')
      `;
      await upgradeAdmin`
        insert into artifacts
          (id, run_id, key, media_type, size_bytes, digest, uri, retention_class, created_at, cleanup_at)
        values
          (${recordId}, ${runId}, ${logicalKey}, 'text/plain', 4, ${digest}, ${uri}, 'source-bundle', '2026-08-17T00:00:00.000Z', '2026-08-17T23:45:00.000Z'),
          (${overMarginRecordId}, ${runId}, ${overMarginLogicalKey}, 'text/plain', 4, ${overMarginDigest}, ${overMarginUri}, 'source-bundle', '2026-08-17T00:00:00.000Z', '2026-08-17T23:45:00.001Z'),
          ('legacy-row', ${runId}, 'legacy-report', null, null, 'legacy', null, null, '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z')
      `;

      const migration = readFileSync(
        resolve(migrationDirectory, '0008_concerned_wither.sql'),
        'utf8',
      )
        .replaceAll('"public".', `"${upgradeSchema}".`)
        .split('--> statement-breakpoint');
      for (const statement of migration)
        if (statement.trim() !== '') await upgradeAdmin.unsafe(statement);

      const upgradeRepository = new NeonDomainRepository(
        drizzle(upgradeAdmin, { schema }) as never,
      );
      const manifest = createDomainArtifactManifestStore(upgradeRepository);
      await expect(
        manifest.get({ projectId, runId, stepId }, uri),
      ).resolves.toMatchObject({ key: uri, digest });
      await expect(
        manifest.list({ scope: { projectId, runId, stepId }, limit: 10 }),
      ).resolves.toMatchObject({ items: [{ key: uri }] });
      await expect(
        upgradeRepository.listArtifactsDueForCleanup(
          isoTimestamp('2026-08-18T00:00:00.000001Z'),
          10,
        ),
      ).resolves.toHaveLength(1);
      await expect(
        upgradeRepository.getArtifact(persistenceId('artifact', 'legacy-row')),
      ).resolves.not.toHaveProperty('manifestVersion');
      await expect(
        upgradeRepository.getArtifact(
          persistenceId('artifact', overMarginRecordId),
        ),
      ).resolves.not.toHaveProperty('manifestVersion');
    } finally {
      await upgradeAdmin.end();
      await admin.unsafe(`drop schema "${upgradeSchema}" cascade`);
    }
  }, 30_000);
});
