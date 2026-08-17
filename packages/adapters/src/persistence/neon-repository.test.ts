import { readFileSync } from 'node:fs';

import { isoTimestamp, persistenceId } from '@agentos/core';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/neon-http';
import { describe, expect, it, vi } from 'vitest';

import {
  EventFingerprintConflictError,
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

function repositoryWithRows(
  rows: readonly Record<string, unknown>[],
  claimToken = 'test-claim-token',
) {
  const execute = vi.fn().mockResolvedValue({ rows });
  return {
    execute,
    repository: new NeonDomainRepository(
      { execute } as never,
      () => claimToken,
    ),
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

  it('applies configuration with one serialized atomic statement', async () => {
    const at = isoTimestamp('2026-08-17T12:00:00.000Z');
    const project = {
      id: persistenceId('project', 'configuration-project'),
      name: 'Configuration Project',
      createdAt: at,
      updatedAt: at,
    } as const;
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
    const recorded = { ...revision, revision: 1 };
    const { execute, repository } = repositoryWithRows([recorded]);

    await expect(
      repository.applyConfigRevision(project, revision),
    ).resolves.toEqual(recorded);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executedSql(execute)).toContain('pg_advisory_xact_lock');
    expect(executedSql(execute)).toContain('on conflict ("id")');

    const conflict = repositoryWithRows([
      { ...recorded, config: { version: 2 } },
    ]).repository;
    await expect(
      conflict.applyConfigRevision(project, revision),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
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
      type: 'run.started',
      payload: null,
      occurredAt: isoTimestamp('2026-08-16T12:00:00.000Z'),
    } as const;
    const replay = repositoryWithRows([
      { ...event, sequence: '1', payloadPresent: true },
    ]);

    await expect(replay.repository.appendEvent(event)).resolves.toEqual({
      ...event,
      sequence: 1,
    });
    expect(replay.execute).toHaveBeenCalledTimes(1);
    expect(executedSql(replay.execute)).toMatch(/from "agentos_append_event"/);
    expect(executedQuery(replay.execute).params).toContain('null');

    const conflictError = Object.assign(new Error('agentos_event_conflict'), {
      code: 'P0001',
    });
    const execute = vi.fn().mockRejectedValue(conflictError);
    const conflict = {
      execute,
      repository: new NeonDomainRepository({ execute } as never),
    };
    await expect(conflict.repository.appendEvent(event)).rejects.toBeInstanceOf(
      EventFingerprintConflictError,
    );
    expect(conflict.execute).toHaveBeenCalledTimes(1);
  });

  it('accepts postgres-js array results through the integration database path', async () => {
    const event = eventWithSequence(91);
    const execute = vi
      .fn()
      .mockResolvedValue([{ ...event, sequence: '91', payloadPresent: false }]);
    const repository = new NeonDomainRepository({ execute } as never);

    await expect(repository.appendEvent(event)).resolves.toEqual(event);
  });

  it('delegates each serialized mutation to one database function call', async () => {
    const occurredAt = isoTimestamp('2026-08-16T12:01:00.000Z');
    const event = {
      runId,
      eventId: persistenceId('event', 'atomic-event'),
      fingerprint: 'sha256:atomic',
      type: 'atomic.changed',
      payload: { messageId: 'message-1' },
      occurredAt,
    } as const;
    const run = repositoryWithRows([
      {
        id: runId,
        projectId: 'project-1',
        pipeline: 'feature',
        status: 'cancelled',
        input: null,
        inputPresent: false,
        output: null,
        outputPresent: false,
        error: null,
        errorPresent: false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
        completedAt: occurredAt,
        eventFingerprint: event.fingerprint,
        eventType: event.type,
        eventPayload: event.payload,
      },
    ]);
    await run.repository.cancelRunWithEvent(
      runId,
      { status: 'cancelled', updatedAt: occurredAt, completedAt: occurredAt },
      event,
    );
    expect(run.execute).toHaveBeenCalledTimes(1);
    expect(executedSql(run.execute)).toContain(
      'from "agentos_cancel_run_with_event"',
    );

    const approval = repositoryWithRows([
      {
        id: 'approval-1',
        runId,
        scope: 'merge:42',
        fingerprint: 'scope-hash',
        status: 'consumed',
        createdAt: occurredAt,
        expiresAt: isoTimestamp('2026-08-17T12:01:00.000Z'),
        consumedAt: occurredAt,
        eventFingerprint: event.fingerprint,
        eventType: event.type,
        eventPayload: event.payload,
      },
    ]);
    await approval.repository.consumeApprovalWithEvent(
      {
        approvalId: persistenceId('approval', 'approval-1'),
        runId,
        scope: 'merge:42',
        fingerprint: 'scope-hash',
        consumedAt: occurredAt,
      },
      event,
    );
    expect(approval.execute).toHaveBeenCalledTimes(1);
    expect(executedSql(approval.execute)).toContain(
      'from "agentos_consume_approval_with_event"',
    );

    const inbox = repositoryWithRows([
      {
        id: 'message-1',
        runId,
        status: 'replied',
        body: { question: 'Proceed?' },
        reply: { answer: 'yes' },
        replyPresent: true,
        createdAt: occurredAt,
        repliedAt: occurredAt,
        eventFingerprint: event.fingerprint,
        eventType: event.type,
        eventPayload: event.payload,
      },
    ]);
    await inbox.repository.replyInboxMessageWithEvent(
      {
        messageId: persistenceId('inboxMessage', 'message-1'),
        reply: { answer: 'yes' },
        repliedAt: occurredAt,
      },
      event,
    );
    expect(inbox.execute).toHaveBeenCalledTimes(1);
    expect(executedSql(inbox.execute)).toContain(
      'from "agentos_reply_inbox_with_event"',
    );
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

  it('pins opaque cursor comparisons and ordering to bytewise collation', async () => {
    const { query, repository } = repositoryRecordingGeneratedQueries();
    const at = isoTimestamp('2026-08-17T12:00:00.000Z');

    await recordGeneratedQuery(query, () =>
      repository.listProjects({
        limit: 2,
        after: { at, id: persistenceId('project', 'Z') },
      }),
    );
    expect(query.mock.calls.at(-1)?.[0]).toMatch(/id" collate "C"/);

    await recordGeneratedQuery(query, () =>
      repository.listStepRuns(runId, {
        limit: 2,
        after: { stepKey: 'Z', attempt: 1 },
      }),
    );
    expect(
      ((query.mock.calls.at(-1)?.[0] as string | undefined) ?? '').match(
        /step_key" collate "C"/g,
      ),
    ).toHaveLength(3);
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
    const replay = repositoryWithRows([
      {
        ...usage,
        inputTokens: '1',
        outputTokens: '2',
        runtimeMs: '3',
        microdollars: '4',
      },
    ]);
    await expect(replay.repository.appendUsage(usage)).resolves.toEqual(usage);
    expect(replay.execute).toHaveBeenCalledTimes(1);
    expect(executedSql(replay.execute)).toMatch(
      /insert into "usage_records"[\s\S]*on conflict[\s\S]*do update[\s\S]*returning/,
    );
    expect(executedSql(replay.execute)).not.toContain('::float8');

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
    const claimed = repositoryWithRows([
      { ...receipt, claimToken: 'test-claim-token' },
    ]);
    await expect(claimed.repository.claimWebhook(receipt)).resolves.toEqual({
      claimed: true,
      receipt,
    });
    expect(claimed.execute).toHaveBeenCalledTimes(1);
    expect(executedSql(claimed.execute)).toMatch(
      /insert into "webhook_receipts"[\s\S]*"claim_token"[\s\S]*on conflict[\s\S]*do update[\s\S]*returning/,
    );
    expect(executedSql(claimed.execute)).not.toContain('xmax');

    const replay = repositoryWithRows(
      [{ ...receipt, claimToken: 'original-claim-token' }],
      'replay-claim-token',
    );
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
