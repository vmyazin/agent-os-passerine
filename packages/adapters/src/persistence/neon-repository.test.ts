import { readFileSync } from 'node:fs';

import { isoTimestamp, persistenceId } from '@agentos/core';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/neon-http';
import { describe, expect, it, vi } from 'vitest';

import {
  EventFingerprintConflictError,
  EventSequenceConflictError,
  IdempotencyConflictError,
} from './errors.js';
import {
  createNeonDomainRepository,
  createNeonDomainRepositoryFromEnv,
  NeonDomainRepository,
} from './neon-repository.js';
import * as schema from './schema.js';

const source = readFileSync(
  new URL('./neon-repository.ts', import.meta.url),
  'utf8',
);

function repositoryWithRows(rows: readonly Record<string, unknown>[]) {
  const execute = vi.fn().mockResolvedValue({ rows });
  return {
    execute,
    repository: new NeonDomainRepository({ execute } as never),
  };
}

function repositoryRecordingGeneratedQueries() {
  const query = vi.fn().mockResolvedValue({
    command: 'INSERT',
    fields: [],
    rowAsArray: true,
    rowCount: 1,
    rows: [[]],
  });
  const database = drizzle({ client: { query } as never, schema });
  return { query, repository: new NeonDomainRepository(database) };
}

function latestParameters(query: ReturnType<typeof vi.fn>): readonly unknown[] {
  return (query.mock.calls.at(-1)?.[1] ?? []) as readonly unknown[];
}

function expectJsonNullParameters(
  query: ReturnType<typeof vi.fn>,
  count: number,
) {
  expect(
    latestParameters(query).filter((parameter) => parameter === 'null'),
  ).toHaveLength(count);
  expect(
    ((query.mock.calls.at(-1)?.[0] as string | undefined) ?? '').match(
      /::jsonb/g,
    ) ?? [],
  ).toHaveLength(count);
}

async function recordGeneratedQuery(
  query: ReturnType<typeof vi.fn>,
  action: () => Promise<unknown>,
) {
  const callsBefore = query.mock.calls.length;
  await action().catch(() => undefined);
  expect(query).toHaveBeenCalledTimes(callsBefore + 1);
}

function executedSql(execute: ReturnType<typeof vi.fn>): string {
  return executedQuery(execute).sql.toLowerCase();
}

function executedQuery(execute: ReturnType<typeof vi.fn>) {
  const statement = execute.mock.calls[0]?.[0] as SQL | undefined;
  if (statement === undefined) throw new Error('expected a SQL statement');
  return new PgDialect().sqlToQuery(statement);
}

const runId = persistenceId('run', 'run-1');

function eventWithSequence(sequence = 1) {
  return {
    runId,
    eventId: persistenceId('event', `event-sequence-${String(sequence)}`),
    fingerprint: `sha256:event-${String(sequence)}`,
    sequence,
    type: 'run.updated',
    occurredAt: isoTimestamp('2026-08-16T12:01:00.000Z'),
  } as const;
}

describe('NeonDomainRepository', () => {
  it('does not require or connect to a database during import', () => {
    expect(NeonDomainRepository).toBeTypeOf('function');
  });

  it('constructs the adapter without making a network request', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      expect(
        createNeonDomainRepository(
          'postgresql://user:secret@example.neon.tech/agentos?sslmode=require',
        ),
      ).toBeInstanceOf(NeonDomainRepository);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('fails closed before constructing a client when database configuration is absent', () => {
    expect(() => createNeonDomainRepositoryFromEnv({})).toThrow(
      'DATABASE_URL is required',
    );
  });

  it('uses a single atomic statement to resolve event replay and conflicts', async () => {
    const event = {
      runId,
      eventId: persistenceId('event', 'event-1'),
      fingerprint: 'sha256:event',
      sequence: 1,
      type: 'run.started',
      payload: null,
      occurredAt: isoTimestamp('2026-08-16T12:00:00.000Z'),
    } as const;
    const replay = repositoryWithRows([{ ...event, payloadPresent: true }]);

    await expect(replay.repository.appendEvent(event)).resolves.toEqual(event);
    expect(replay.execute).toHaveBeenCalledTimes(1);
    expect(executedSql(replay.execute)).toMatch(
      /insert into "domain_events"[\s\S]*on conflict[\s\S]*do update[\s\S]*returning/,
    );
    expect(executedQuery(replay.execute).params).toContain('null');

    const conflict = repositoryWithRows([
      { ...event, fingerprint: 'sha256:different', payloadPresent: true },
    ]);
    await expect(conflict.repository.appendEvent(event)).rejects.toBeInstanceOf(
      EventFingerprintConflictError,
    );
    expect(conflict.execute).toHaveBeenCalledTimes(1);
  });

  it('maps a duplicate event sequence to the domain conflict atomically', async () => {
    const execute = vi.fn().mockRejectedValue(
      Object.assign(
        new Error('duplicate key value violates unique constraint'),
        {
          code: '23505',
          constraint: 'domain_events_run_sequence_unique',
        },
      ),
    );
    const repository = new NeonDomainRepository({ execute } as never);

    await expect(
      repository.appendEvent({
        runId,
        eventId: persistenceId('event', 'event-with-duplicate-sequence'),
        fingerprint: 'sha256:event-two',
        sequence: 1,
        type: 'run.updated',
        occurredAt: isoTimestamp('2026-08-16T12:01:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(EventSequenceConflictError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('unwraps a Drizzle query error to map the named sequence constraint', async () => {
    const postgresError = Object.assign(
      new Error('duplicate key value violates unique constraint'),
      {
        code: '23505',
        constraint: 'domain_events_run_sequence_unique',
      },
    );
    const query = vi.fn().mockRejectedValue(postgresError);
    const database = drizzle({ client: { query } as never, schema });
    const repository = new NeonDomainRepository(database);

    await expect(
      repository.appendEvent(eventWithSequence(2)),
    ).rejects.toBeInstanceOf(EventSequenceConflictError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('stops safely on cyclic or hostile error cause chains', async () => {
    const cyclic = new Error('cyclic');
    Object.assign(cyclic, { cause: cyclic });
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('cause getter must not escape');
      },
    });

    for (const error of [cyclic, hostile]) {
      const execute = vi.fn().mockRejectedValue(error);
      const repository = new NeonDomainRepository({ execute } as never);
      let received: unknown;
      try {
        await repository.appendEvent(eventWithSequence(3));
      } catch (caught) {
        received = caught;
      }
      expect(received).toBe(error);
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it('encodes required top-level JSON null as JSONB on Drizzle inserts', async () => {
    const { query, repository } = repositoryRecordingGeneratedQueries();
    const createdAt = isoTimestamp('2026-08-16T12:00:00.000Z');
    const projectId = persistenceId('project', 'project-json');
    const configRevisionId = persistenceId('configRevision', 'config-json');

    await recordGeneratedQuery(query, () =>
      repository.createConfigRevision({
        id: configRevisionId,
        projectId,
        revision: 1,
        config: null,
        configDigest: 'config',
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
        repositorySha: 'sha',
        createdAt,
      }),
    );
    expectJsonNullParameters(query, 1);

    await recordGeneratedQuery(query, () =>
      repository.createConfigSnapshot({
        id: persistenceId('configSnapshot', 'snapshot-json'),
        runId,
        configRevisionId,
        config: null,
        configDigest: 'config',
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
        repositorySha: 'sha',
        createdAt,
      }),
    );
    expectJsonNullParameters(query, 1);

    await recordGeneratedQuery(query, () =>
      repository.createInboxMessage({
        id: persistenceId('inboxMessage', 'inbox-json'),
        runId,
        status: 'pending',
        body: null,
        reply: null,
        createdAt,
      }),
    );
    expectJsonNullParameters(query, 2);
  });

  it('encodes optional JSON null while leaving absent fields as SQL NULL', async () => {
    const { query, repository } = repositoryRecordingGeneratedQueries();
    const createdAt = isoTimestamp('2026-08-16T12:00:00.000Z');
    const projectId = persistenceId('project', 'project-json');
    await recordGeneratedQuery(query, () =>
      repository.createRun({
        id: runId,
        projectId,
        pipeline: 'json',
        status: 'pending',
        input: null,
        output: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
      }),
    );
    expectJsonNullParameters(query, 3);

    await recordGeneratedQuery(query, () =>
      repository.updateRun(runId, {
        output: null,
        error: null,
        updatedAt: createdAt,
      }),
    );
    expectJsonNullParameters(query, 2);

    await recordGeneratedQuery(query, () =>
      repository.upsertStepRun({
        id: persistenceId('stepRun', 'step-json'),
        runId,
        stepKey: 'json',
        attempt: 1,
        status: 'pending',
        input: null,
        output: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
      }),
    );
    expectJsonNullParameters(query, 6);

    await recordGeneratedQuery(query, () =>
      repository.createExternalSession({
        id: persistenceId('externalSession', 'session-json'),
        runId,
        provider: 'test',
        externalId: 'external-json',
        status: 'active',
        state: null,
        createdAt,
      }),
    );
    expectJsonNullParameters(query, 1);

    await recordGeneratedQuery(query, () =>
      repository.replyInboxMessage({
        messageId: persistenceId('inboxMessage', 'inbox-json'),
        reply: null,
        repliedAt: createdAt,
      }),
    );
    expectJsonNullParameters(query, 1);

    await recordGeneratedQuery(query, () =>
      repository.appendGoalProgress({
        id: persistenceId('goalProgress', 'progress-json'),
        runId,
        status: 'pending',
        payload: null,
        recordedAt: createdAt,
      }),
    );
    expectJsonNullParameters(query, 1);

    await recordGeneratedQuery(query, () =>
      repository.createRun({
        id: persistenceId('run', 'run-with-absent-json'),
        projectId,
        pipeline: 'json',
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
      }),
    );
    expectJsonNullParameters(query, 0);
  });

  it('uses a single atomic statement to resolve usage idempotency', async () => {
    const usage = {
      idempotencyId: persistenceId('usage', 'usage-1'),
      runId,
      model: 'openai/test',
      inputTokens: 1,
      outputTokens: 2,
      runtimeMs: 3,
      microdollars: 4,
      recordedAt: isoTimestamp('2026-08-16T12:00:00.000Z'),
    } as const;
    const replay = repositoryWithRows([usage]);
    await expect(replay.repository.appendUsage(usage)).resolves.toEqual(usage);
    expect(replay.execute).toHaveBeenCalledTimes(1);
    expect(executedSql(replay.execute)).toMatch(
      /insert into "usage_records"[\s\S]*on conflict[\s\S]*do update[\s\S]*returning/,
    );

    const conflict = repositoryWithRows([{ ...usage, microdollars: 99 }]);
    await expect(conflict.repository.appendUsage(usage)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(conflict.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects usage replays that differ below millisecond precision', async () => {
    const usage = {
      idempotencyId: persistenceId('usage', 'usage-precise'),
      runId,
      model: 'openai/test',
      inputTokens: 1,
      outputTokens: 2,
      runtimeMs: 3,
      microdollars: 4,
      recordedAt: isoTimestamp('2026-08-16T12:00:00.123456Z'),
    } as const;
    const conflict = repositoryWithRows([
      { ...usage, recordedAt: '2026-08-16T12:00:00.123999Z' },
    ]);

    await expect(conflict.repository.appendUsage(usage)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(executedSql(conflict.execute)).toContain('ss.us');
  });

  it('claims or replays a webhook in one statement', async () => {
    const receipt = {
      source: 'github',
      deliveryId: persistenceId('webhookDelivery', 'delivery-1'),
      fingerprint: 'sha256:webhook',
      receivedAt: isoTimestamp('2026-08-16T12:00:00.000Z'),
      expiresAt: isoTimestamp('2026-08-23T12:00:00.000Z'),
    } as const;
    const claimed = repositoryWithRows([{ ...receipt, claimed: true }]);
    await expect(claimed.repository.claimWebhook(receipt)).resolves.toEqual({
      claimed: true,
      receipt,
    });
    expect(claimed.execute).toHaveBeenCalledTimes(1);
    expect(executedSql(claimed.execute)).toMatch(
      /insert into "webhook_receipts"[\s\S]*on conflict[\s\S]*do update[\s\S]*xmax[\s\S]*returning|returning[\s\S]*xmax/,
    );

    const replay = repositoryWithRows([{ ...receipt, claimed: false }]);
    await expect(replay.repository.claimWebhook(receipt)).resolves.toEqual({
      claimed: false,
      receipt,
    });
    expect(replay.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps step upsert identity and creation fields out of the update set', () => {
    expect(source).toContain('onConflictDoUpdate');
    expect(source).toContain(
      'target: [stepRuns.runId, stepRuns.stepKey, stepRuns.attempt]',
    );
    const upsert = source.slice(
      source.indexOf('async upsertStepRun'),
      source.indexOf('async getStepRun'),
    );
    expect(upsert).not.toContain('id: step.id');
    expect(upsert).not.toContain('createdAt: step.createdAt');
  });

  it('consumes approvals and replies with conditional updates', () => {
    const consumeApproval = source.slice(
      source.indexOf('async consumeApproval'),
      source.indexOf('async createInboxMessage'),
    );
    expect(source).toContain("eq(approvals.status, 'pending')");
    expect(source).toContain('gt(approvals.expiresAt, request.consumedAt)');
    expect(source).toContain('eq(approvals.fingerprint, request.fingerprint)');
    expect(source).toContain("eq(inboxMessages.status, 'pending')");
    expect(consumeApproval).not.toContain('.select(');
  });
});
