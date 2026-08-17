import { randomUUID } from 'node:crypto';
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
  EventSequenceConflictError,
  IdempotencyConflictError,
} from './errors.js';
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

  it('resolves concurrent event replays and both event conflict keys', async () => {
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

    await expect(
      Promise.all([
        repository.appendEvent(event),
        repository.appendEvent(event),
      ]),
    ).resolves.toHaveLength(2);
    await expect(
      repository.appendEvent({ ...event, fingerprint: 'sha256:different' }),
    ).rejects.toBeInstanceOf(EventFingerprintConflictError);
    await expect(
      repository.appendEvent({
        ...event,
        eventId: persistenceId('event', 'event-sequence-conflict'),
        fingerprint: 'sha256:sequence',
      }),
    ).rejects.toBeInstanceOf(EventSequenceConflictError);
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
});
