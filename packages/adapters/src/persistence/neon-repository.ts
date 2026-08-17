import { randomUUID } from 'node:crypto';

import { neon, types } from '@neondatabase/serverless';
import { isoTimestampEpochMicroseconds } from '@agentos/core';
import type {
  Approval,
  ApprovalId,
  ApprovalListFilter,
  ArtifactId,
  ArtifactRecord,
  ConfigRevision,
  ConfigRevisionId,
  ConfigSnapshot,
  ConfigSnapshotId,
  ConsumeApprovalRequest,
  DomainEvent,
  DomainEventDraft,
  DomainRepository,
  EventId,
  ExternalSession,
  ExternalSessionId,
  ExternalSessionListFilter,
  GoalCriterion,
  GoalProgress,
  GoalProgressId,
  InboxMessage,
  InboxMessageId,
  JsonValue,
  ListPage,
  Project,
  ProjectId,
  ReplyInboxMessageRequest,
  RunListFilter,
  StepRun,
  StepRunId,
  StepRunListCursor,
  TimestampListCursor,
  UsageId,
  UsageRecordEntry,
  WebhookClaim,
  WebhookReceipt,
  WorkflowRun,
  WorkflowRunId,
  WorkflowRunUpdate,
} from '@agentos/core';
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';

import {
  databaseUrlFromEnv,
  type DatabaseEnvironment,
} from './database-config.js';
import {
  EventFingerprintConflictError,
  IdempotencyConflictError,
} from './errors.js';
import {
  approvalSelection,
  artifactSelection,
  configRevisionSelection,
  configSnapshotSelection,
  domainEventSelection,
  externalSessionSelection,
  goalCriterionSelection,
  goalProgressSelection,
  inboxMessageSelection,
  mapApprovalRow,
  mapArtifactRow,
  mapConfigRevisionRow,
  mapConfigSnapshotRow,
  mapDomainEventRow,
  mapExternalSessionRow,
  mapGoalCriterionRow,
  mapGoalProgressRow,
  mapInboxMessageRow,
  mapProjectRow,
  mapStepRunRow,
  mapUsageRecordRow,
  mapWebhookReceiptRow,
  mapWorkflowRunRow,
  projectSelection,
  stepRunSelection,
  usageRecordSelection,
  workflowRunSelection,
} from './row-mapping.js';
import * as schema from './schema.js';
import {
  approvals,
  artifacts,
  configRevisions,
  configSnapshots,
  domainEvents,
  externalSessions,
  goalCriteria,
  goalProgress,
  inboxMessages,
  projects,
  stepRuns,
  usageRecords,
  workflowRuns,
} from './schema.js';
import {
  assertNonNegativeSafeInteger,
  assertValidArtifact,
  assertValidConfigRevision,
  assertValidGoalCriterion,
  assertValidStepRun,
  assertValidUsage,
} from './validation.js';
import { boundedListLimit } from './pagination.js';

type Database = NeonHttpDatabase<typeof schema>;

function one<T>(rows: readonly T[], description: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${description} was not returned`);
  return row;
}

function executionRows(
  result: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  if (Array.isArray(result)) {
    return result as readonly Readonly<Record<string, unknown>>[];
  }
  if (typeof result === 'object' && result !== null) {
    const rows = Reflect.get(result, 'rows');
    if (Array.isArray(rows)) {
      return rows as readonly Readonly<Record<string, unknown>>[];
    }
  }
  throw new TypeError('Database execution did not return rows');
}

function mappedOne<T>(
  rows: readonly Readonly<Record<string, unknown>>[],
  description: string,
  mapper: (row: Readonly<Record<string, unknown>>) => T,
): T {
  return mapper(one(rows, description));
}

function mappedRows<T>(
  rows: readonly Readonly<Record<string, unknown>>[],
  mapper: (row: Readonly<Record<string, unknown>>) => T,
): readonly T[] {
  return rows.map(mapper);
}

function usageMatches(row: UsageRecordEntry, usage: UsageRecordEntry): boolean {
  return (
    row.idempotencyId === usage.idempotencyId &&
    row.runId === usage.runId &&
    row.stepRunId === usage.stepRunId &&
    row.model === usage.model &&
    row.inputTokens === usage.inputTokens &&
    row.outputTokens === usage.outputTokens &&
    row.runtimeMs === usage.runtimeMs &&
    row.microdollars === usage.microdollars &&
    isoTimestampEpochMicroseconds(row.recordedAt) ===
      isoTimestampEpochMicroseconds(usage.recordedAt)
  );
}

function databaseSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  assertNonNegativeSafeInteger(parsed, field);
  return parsed;
}

function afterTimestamp(
  timestampColumn: PgColumn,
  idColumn: PgColumn,
  cursor: TimestampListCursor<string> | undefined,
) {
  const orderedId = bytewiseText(idColumn);
  return cursor === undefined
    ? undefined
    : or(
        gt(timestampColumn, cursor.at),
        and(eq(timestampColumn, cursor.at), gt(orderedId, cursor.id)),
      );
}

function bytewiseText(column: PgColumn) {
  return sql`${column} collate "C"`;
}

function jsonbValue(value: JsonValue) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function optionalJsonbValue(value: JsonValue | undefined) {
  return value === undefined ? undefined : jsonbValue(value);
}

function nullableJsonbValue(value: JsonValue | undefined) {
  return value === undefined ? sql`null` : jsonbValue(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertEventReplayMatches(
  row: Readonly<Record<string, unknown>>,
  event: DomainEventDraft,
): void {
  if (
    row.eventFingerprint !== event.fingerprint ||
    row.eventType !== event.type ||
    !sameJson(row.eventPayload ?? undefined, event.payload)
  ) {
    throw new EventFingerprintConflictError(event.runId, event.eventId);
  }
}

function withoutEventMetadata(
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const entity = { ...row };
  delete entity.eventFingerprint;
  delete entity.eventType;
  delete entity.eventPayload;
  return entity;
}

const timestampTypeParsers = {
  getTypeParser(id: number, format?: 'text' | 'binary') {
    if (id === types.builtins.TIMESTAMPTZ && format !== 'binary') {
      return (value: string) => value;
    }
    return types.getTypeParser(id, format);
  },
};

export class NeonDomainRepository implements DomainRepository {
  public constructor(
    private readonly database: Database,
    private readonly createClaimToken: () => string = randomUUID,
  ) {}

  async createProject(project: Project): Promise<Project> {
    return mappedOne(
      await this.database
        .insert(projects)
        .values(project)
        .returning(projectSelection),
      'Project',
      mapProjectRow,
    );
  }

  async getProject(id: ProjectId): Promise<Project | undefined> {
    const [row] = await this.database
      .select(projectSelection)
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    return row === undefined ? undefined : mapProjectRow(row);
  }

  async listProjects(
    page: ListPage<TimestampListCursor<ProjectId>> = {},
  ): Promise<readonly Project[]> {
    return mappedRows(
      await this.database
        .select(projectSelection)
        .from(projects)
        .where(afterTimestamp(projects.createdAt, projects.id, page.after))
        .orderBy(asc(projects.createdAt), asc(bytewiseText(projects.id)))
        .limit(boundedListLimit(page.limit)),
      mapProjectRow,
    );
  }

  async createConfigRevision(
    revision: ConfigRevision,
  ): Promise<ConfigRevision> {
    assertValidConfigRevision(revision);
    return mappedOne(
      await this.database
        .insert(configRevisions)
        .values({ ...revision, config: jsonbValue(revision.config) })
        .returning(configRevisionSelection),
      'Config revision',
      mapConfigRevisionRow,
    );
  }

  async getConfigRevision(
    id: ConfigRevisionId,
  ): Promise<ConfigRevision | undefined> {
    const [row] = await this.database
      .select(configRevisionSelection)
      .from(configRevisions)
      .where(eq(configRevisions.id, id))
      .limit(1);
    return row === undefined ? undefined : mapConfigRevisionRow(row);
  }

  async listConfigRevisions(
    projectId: ProjectId,
    page: ListPage<number> = {},
  ): Promise<readonly ConfigRevision[]> {
    return mappedRows(
      await this.database
        .select(configRevisionSelection)
        .from(configRevisions)
        .where(
          and(
            eq(configRevisions.projectId, projectId),
            page.after === undefined
              ? undefined
              : gt(configRevisions.revision, page.after),
          ),
        )
        .orderBy(asc(configRevisions.revision))
        .limit(boundedListLimit(page.limit)),
      mapConfigRevisionRow,
    );
  }

  async createConfigSnapshot(
    snapshot: ConfigSnapshot,
  ): Promise<ConfigSnapshot> {
    return mappedOne(
      await this.database
        .insert(configSnapshots)
        .values({ ...snapshot, config: jsonbValue(snapshot.config) })
        .returning(configSnapshotSelection),
      'Config snapshot',
      mapConfigSnapshotRow,
    );
  }

  async getConfigSnapshot(
    id: ConfigSnapshotId,
  ): Promise<ConfigSnapshot | undefined> {
    const [row] = await this.database
      .select(configSnapshotSelection)
      .from(configSnapshots)
      .where(eq(configSnapshots.id, id))
      .limit(1);
    return row === undefined ? undefined : mapConfigSnapshotRow(row);
  }

  async listConfigSnapshots(
    runId: WorkflowRunId,
    page: ListPage<TimestampListCursor<ConfigSnapshotId>> = {},
  ): Promise<readonly ConfigSnapshot[]> {
    return mappedRows(
      await this.database
        .select(configSnapshotSelection)
        .from(configSnapshots)
        .where(
          and(
            eq(configSnapshots.runId, runId),
            afterTimestamp(
              configSnapshots.createdAt,
              configSnapshots.id,
              page.after,
            ),
          ),
        )
        .orderBy(
          asc(configSnapshots.createdAt),
          asc(bytewiseText(configSnapshots.id)),
        )
        .limit(boundedListLimit(page.limit)),
      mapConfigSnapshotRow,
    );
  }

  async createRun(run: WorkflowRun): Promise<WorkflowRun> {
    return mappedOne(
      await this.database
        .insert(workflowRuns)
        .values({
          ...run,
          input: optionalJsonbValue(run.input),
          output: optionalJsonbValue(run.output),
          error: optionalJsonbValue(run.error),
        })
        .returning(workflowRunSelection),
      'Run',
      mapWorkflowRunRow,
    );
  }

  async getRun(id: WorkflowRunId): Promise<WorkflowRun | undefined> {
    const [row] = await this.database
      .select(workflowRunSelection)
      .from(workflowRuns)
      .where(eq(workflowRuns.id, id))
      .limit(1);
    return row === undefined ? undefined : mapWorkflowRunRow(row);
  }

  async listRuns(filter: RunListFilter = {}): Promise<readonly WorkflowRun[]> {
    return mappedRows(
      await this.database
        .select(workflowRunSelection)
        .from(workflowRuns)
        .where(
          and(
            filter.projectId === undefined
              ? undefined
              : eq(workflowRuns.projectId, filter.projectId),
            filter.status === undefined
              ? undefined
              : eq(workflowRuns.status, filter.status),
            afterTimestamp(
              workflowRuns.createdAt,
              workflowRuns.id,
              filter.after,
            ),
          ),
        )
        .orderBy(
          asc(workflowRuns.createdAt),
          asc(bytewiseText(workflowRuns.id)),
        )
        .limit(boundedListLimit(filter.limit)),
      mapWorkflowRunRow,
    );
  }

  async updateRun(
    id: WorkflowRunId,
    update: WorkflowRunUpdate,
  ): Promise<WorkflowRun> {
    return mappedOne(
      await this.database
        .update(workflowRuns)
        .set({
          ...update,
          output: optionalJsonbValue(update.output),
          error: optionalJsonbValue(update.error),
        })
        .where(eq(workflowRuns.id, id))
        .returning(workflowRunSelection),
      `Run ${id}`,
      mapWorkflowRunRow,
    );
  }

  async upsertStepRun(step: StepRun): Promise<StepRun> {
    assertValidStepRun(step);
    const rows = await this.database
      .insert(stepRuns)
      .values({
        ...step,
        input: optionalJsonbValue(step.input),
        output: optionalJsonbValue(step.output),
        error: optionalJsonbValue(step.error),
      })
      .onConflictDoUpdate({
        target: [stepRuns.runId, stepRuns.stepKey, stepRuns.attempt],
        set: {
          status: step.status,
          input: optionalJsonbValue(step.input),
          output: optionalJsonbValue(step.output),
          error: optionalJsonbValue(step.error),
          externalSessionId: step.externalSessionId,
          updatedAt: step.updatedAt,
          startedAt: step.startedAt,
          completedAt: step.completedAt,
          cleanupAt: step.cleanupAt,
        },
      })
      .returning(stepRunSelection);
    return mappedOne(rows, 'Step run', mapStepRunRow);
  }

  async getStepRun(id: StepRunId): Promise<StepRun | undefined> {
    const [row] = await this.database
      .select(stepRunSelection)
      .from(stepRuns)
      .where(eq(stepRuns.id, id))
      .limit(1);
    return row === undefined ? undefined : mapStepRunRow(row);
  }

  async listStepRuns(
    runId: WorkflowRunId,
    page: ListPage<StepRunListCursor> = {},
  ): Promise<readonly StepRun[]> {
    return mappedRows(
      await this.database
        .select(stepRunSelection)
        .from(stepRuns)
        .where(
          and(
            eq(stepRuns.runId, runId),
            page.after === undefined
              ? undefined
              : or(
                  gt(bytewiseText(stepRuns.stepKey), page.after.stepKey),
                  and(
                    eq(bytewiseText(stepRuns.stepKey), page.after.stepKey),
                    gt(stepRuns.attempt, page.after.attempt),
                  ),
                ),
          ),
        )
        .orderBy(asc(bytewiseText(stepRuns.stepKey)), asc(stepRuns.attempt))
        .limit(boundedListLimit(page.limit)),
      mapStepRunRow,
    );
  }

  async createExternalSession(
    session: ExternalSession,
  ): Promise<ExternalSession> {
    return mappedOne(
      await this.database
        .insert(externalSessions)
        .values({ ...session, state: optionalJsonbValue(session.state) })
        .returning(externalSessionSelection),
      'External session',
      mapExternalSessionRow,
    );
  }

  async getExternalSession(
    id: ExternalSessionId,
  ): Promise<ExternalSession | undefined> {
    const [row] = await this.database
      .select(externalSessionSelection)
      .from(externalSessions)
      .where(eq(externalSessions.id, id))
      .limit(1);
    return row === undefined ? undefined : mapExternalSessionRow(row);
  }

  async listExternalSessions(
    runId: WorkflowRunId,
    filter: ExternalSessionListFilter = {},
  ): Promise<readonly ExternalSession[]> {
    return mappedRows(
      await this.database
        .select(externalSessionSelection)
        .from(externalSessions)
        .where(
          and(
            eq(externalSessions.runId, runId),
            filter.provider === undefined
              ? undefined
              : eq(externalSessions.provider, filter.provider),
            afterTimestamp(
              externalSessions.createdAt,
              externalSessions.id,
              filter.after,
            ),
          ),
        )
        .orderBy(
          asc(externalSessions.createdAt),
          asc(bytewiseText(externalSessions.id)),
        )
        .limit(boundedListLimit(filter.limit)),
      mapExternalSessionRow,
    );
  }

  async createApproval(approval: Approval): Promise<Approval> {
    return mappedOne(
      await this.database
        .insert(approvals)
        .values(approval)
        .returning(approvalSelection),
      'Approval',
      mapApprovalRow,
    );
  }

  async getApproval(id: ApprovalId): Promise<Approval | undefined> {
    const [row] = await this.database
      .select(approvalSelection)
      .from(approvals)
      .where(eq(approvals.id, id))
      .limit(1);
    return row === undefined ? undefined : mapApprovalRow(row);
  }

  async listApprovals(
    runId: WorkflowRunId,
    filter: ApprovalListFilter = {},
  ): Promise<readonly Approval[]> {
    return mappedRows(
      await this.database
        .select(approvalSelection)
        .from(approvals)
        .where(
          and(
            eq(approvals.runId, runId),
            filter.status === undefined
              ? undefined
              : eq(approvals.status, filter.status),
            afterTimestamp(approvals.createdAt, approvals.id, filter.after),
          ),
        )
        .orderBy(asc(approvals.createdAt), asc(bytewiseText(approvals.id)))
        .limit(boundedListLimit(filter.limit)),
      mapApprovalRow,
    );
  }

  async consumeApproval(
    request: ConsumeApprovalRequest,
  ): Promise<Approval | undefined> {
    const rows = await this.database
      .update(approvals)
      .set({ status: 'consumed', consumedAt: request.consumedAt })
      .where(
        and(
          eq(approvals.id, request.approvalId),
          eq(approvals.runId, request.runId),
          eq(approvals.scope, request.scope),
          eq(approvals.fingerprint, request.fingerprint),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, request.consumedAt),
        ),
      )
      .returning(approvalSelection);
    const row = rows[0];
    return row === undefined ? undefined : mapApprovalRow(row);
  }

  async createInboxMessage(message: InboxMessage): Promise<InboxMessage> {
    return mappedOne(
      await this.database
        .insert(inboxMessages)
        .values({
          ...message,
          body: jsonbValue(message.body),
          reply: optionalJsonbValue(message.reply),
        })
        .returning(inboxMessageSelection),
      'Inbox message',
      mapInboxMessageRow,
    );
  }

  async getInboxMessage(id: InboxMessageId): Promise<InboxMessage | undefined> {
    const [row] = await this.database
      .select(inboxMessageSelection)
      .from(inboxMessages)
      .where(eq(inboxMessages.id, id))
      .limit(1);
    return row === undefined ? undefined : mapInboxMessageRow(row);
  }

  async listInboxMessages(
    runId: WorkflowRunId,
    status?: InboxMessage['status'],
    page: ListPage<TimestampListCursor<InboxMessageId>> = {},
  ): Promise<readonly InboxMessage[]> {
    return mappedRows(
      await this.database
        .select(inboxMessageSelection)
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.runId, runId),
            status === undefined ? undefined : eq(inboxMessages.status, status),
            afterTimestamp(
              inboxMessages.createdAt,
              inboxMessages.id,
              page.after,
            ),
          ),
        )
        .orderBy(
          asc(inboxMessages.createdAt),
          asc(bytewiseText(inboxMessages.id)),
        )
        .limit(boundedListLimit(page.limit)),
      mapInboxMessageRow,
    );
  }

  async replyInboxMessage(
    request: ReplyInboxMessageRequest,
  ): Promise<InboxMessage> {
    const rows = await this.database
      .update(inboxMessages)
      .set({
        status: 'replied',
        reply: jsonbValue(request.reply),
        repliedAt: request.repliedAt,
      })
      .where(
        and(
          eq(inboxMessages.id, request.messageId),
          eq(inboxMessages.status, 'pending'),
        ),
      )
      .returning(inboxMessageSelection);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(
        `Inbox message ${request.messageId} not found or already replied`,
      );
    }
    return mapInboxMessageRow(row);
  }

  async appendEvent(event: DomainEventDraft): Promise<DomainEvent> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      with existing as (
        select * from "domain_events"
        where "run_id" = ${event.runId} and "event_id" = ${event.eventId}
      ), allocated as (
        insert into "run_event_sequences" ("run_id", "next_sequence")
        select ${event.runId}, 2 where not exists (select 1 from existing)
        on conflict ("run_id") do update
          set "next_sequence" = "run_event_sequences"."next_sequence" + 1
        returning "next_sequence" - 1 as "sequence"
      ), inserted as (
        insert into "domain_events"
          ("run_id", "event_id", "fingerprint", "sequence", "type", "payload", "occurred_at")
        select ${event.runId}, ${event.eventId}, ${event.fingerprint}, "sequence", ${event.type}, ${nullableJsonbValue(event.payload)}, ${event.occurredAt}
        from allocated
        on conflict ("run_id", "event_id") do update
          set "fingerprint" = "domain_events"."fingerprint"
        returning *
      ), selected as (
        select * from existing union all select * from inserted
      )
      select
        "run_id" as "runId", "event_id" as "eventId", "fingerprint",
        "sequence"::text as "sequence", "type", "payload",
        ("payload" is not null) as "payloadPresent",
        to_char("occurred_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt"
      from selected limit 1
    `);
    const eventRow = one(executionRows(result), 'Event');
    const existing = mapDomainEventRow({
      ...eventRow,
      sequence: databaseSafeInteger(eventRow.sequence, 'sequence'),
    });
    if (
      existing.fingerprint !== event.fingerprint ||
      existing.type !== event.type ||
      !sameJson(existing.payload, event.payload)
    ) {
      throw new EventFingerprintConflictError(event.runId, event.eventId);
    }
    return existing;
  }

  async getEvent(
    runId: WorkflowRunId,
    eventId: EventId,
  ): Promise<DomainEvent | undefined> {
    const [row] = await this.database
      .select(domainEventSelection)
      .from(domainEvents)
      .where(
        and(eq(domainEvents.runId, runId), eq(domainEvents.eventId, eventId)),
      )
      .limit(1);
    return row === undefined ? undefined : mapDomainEventRow(row);
  }

  async cancelRunWithEvent(
    runId: WorkflowRunId,
    update: WorkflowRunUpdate,
    event: DomainEventDraft,
  ): Promise<WorkflowRun> {
    if (event.runId !== runId)
      throw new Error('event run does not match mutation');
    const result = await this.database.execute<Record<string, unknown>>(sql`
      with existing as (
        select * from "domain_events"
        where "run_id" = ${runId} and "event_id" = ${event.eventId}
      ), mutated as (
        update "workflow_runs" set
          "status" = 'cancelled',
          "updated_at" = ${update.updatedAt},
          "completed_at" = ${update.completedAt ?? update.updatedAt}
        where "id" = ${runId}
          and "status" not in ('succeeded', 'failed', 'cancelled')
          and not exists (select 1 from existing)
        returning *
      ), allocated as (
        insert into "run_event_sequences" ("run_id", "next_sequence")
        select ${runId}, 2 from mutated
        on conflict ("run_id") do update
          set "next_sequence" = "run_event_sequences"."next_sequence" + 1
        returning "next_sequence" - 1 as "sequence"
      ), inserted as (
        insert into "domain_events"
          ("run_id", "event_id", "fingerprint", "sequence", "type", "payload", "occurred_at")
        select ${runId}, ${event.eventId}, ${event.fingerprint}, "sequence", ${event.type}, ${nullableJsonbValue(event.payload)}, ${event.occurredAt}
        from allocated returning *
      ), entity as (
        select * from mutated
        union all
        select r.* from existing e join "workflow_runs" r on r."id" = e."run_id"
      ), selected_event as (
        select * from existing union all select * from inserted
      )
      select
        r."id", r."project_id" as "projectId", r."config_revision_id" as "configRevisionId",
        r."pipeline", r."status", r."input", (r."input" is not null) as "inputPresent",
        r."output", (r."output" is not null) as "outputPresent",
        r."error", (r."error" is not null) as "errorPresent",
        to_char(r."created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
        to_char(r."updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",
        to_char(r."started_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "startedAt",
        to_char(r."completed_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "completedAt",
        to_char(r."cleanup_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cleanupAt",
        e."fingerprint" as "eventFingerprint", e."type" as "eventType", e."payload" as "eventPayload"
      from entity r cross join selected_event e limit 1
    `);
    const row = one(executionRows(result), 'Cancelled run');
    assertEventReplayMatches(row, event);
    return mapWorkflowRunRow(withoutEventMetadata(row));
  }

  async consumeApprovalWithEvent(
    request: ConsumeApprovalRequest,
    event: DomainEventDraft,
  ): Promise<Approval | undefined> {
    if (event.runId !== request.runId)
      throw new Error('event run does not match mutation');
    const result = await this.database.execute<Record<string, unknown>>(sql`
      with existing as (
        select * from "domain_events"
        where "run_id" = ${request.runId} and "event_id" = ${event.eventId}
      ), mutated as (
        update "approvals" set "status" = 'consumed', "consumed_at" = ${request.consumedAt}
        where "id" = ${request.approvalId} and "run_id" = ${request.runId}
          and "scope" = ${request.scope} and "fingerprint" = ${request.fingerprint}
          and "status" = 'pending' and "expires_at" > ${request.consumedAt}
          and not exists (select 1 from existing)
        returning *
      ), allocated as (
        insert into "run_event_sequences" ("run_id", "next_sequence")
        select ${request.runId}, 2 from mutated
        on conflict ("run_id") do update
          set "next_sequence" = "run_event_sequences"."next_sequence" + 1
        returning "next_sequence" - 1 as "sequence"
      ), inserted as (
        insert into "domain_events"
          ("run_id", "event_id", "fingerprint", "sequence", "type", "payload", "occurred_at")
        select ${request.runId}, ${event.eventId}, ${event.fingerprint}, "sequence", ${event.type}, ${nullableJsonbValue(event.payload)}, ${event.occurredAt}
        from allocated returning *
      ), entity as (
        select * from mutated
        union all
        select a.* from existing e join "approvals" a on a."run_id" = e."run_id"
          and a."id" = ${request.approvalId}
      ), selected_event as (
        select * from existing union all select * from inserted
      )
      select
        a."id", a."run_id" as "runId", a."scope", a."fingerprint", a."status",
        to_char(a."created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
        to_char(a."expires_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
        to_char(a."consumed_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "consumedAt",
        e."fingerprint" as "eventFingerprint", e."type" as "eventType", e."payload" as "eventPayload"
      from entity a cross join selected_event e limit 1
    `);
    const [row] = executionRows(result);
    if (row === undefined) return undefined;
    assertEventReplayMatches(row, event);
    return mapApprovalRow(withoutEventMetadata(row));
  }

  async replyInboxMessageWithEvent(
    request: ReplyInboxMessageRequest,
    event: DomainEventDraft,
  ): Promise<InboxMessage> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      with existing as (
        select * from "domain_events"
        where "run_id" = ${event.runId} and "event_id" = ${event.eventId}
      ), mutated as (
        update "inbox_messages" set
          "status" = 'replied', "reply" = ${jsonbValue(request.reply)}, "replied_at" = ${request.repliedAt}
        where "id" = ${request.messageId} and "run_id" = ${event.runId}
          and "status" = 'pending' and not exists (select 1 from existing)
        returning *
      ), allocated as (
        insert into "run_event_sequences" ("run_id", "next_sequence")
        select ${event.runId}, 2 from mutated
        on conflict ("run_id") do update
          set "next_sequence" = "run_event_sequences"."next_sequence" + 1
        returning "next_sequence" - 1 as "sequence"
      ), inserted as (
        insert into "domain_events"
          ("run_id", "event_id", "fingerprint", "sequence", "type", "payload", "occurred_at")
        select ${event.runId}, ${event.eventId}, ${event.fingerprint}, "sequence", ${event.type}, ${nullableJsonbValue(event.payload)}, ${event.occurredAt}
        from allocated returning *
      ), entity as (
        select * from mutated
        union all
        select m.* from existing e join "inbox_messages" m on m."run_id" = e."run_id"
          and m."id" = ${request.messageId}
      ), selected_event as (
        select * from existing union all select * from inserted
      )
      select
        m."id", m."run_id" as "runId", m."step_run_id" as "stepRunId", m."status",
        m."body", m."reply", (m."reply" is not null) as "replyPresent",
        to_char(m."created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
        to_char(m."replied_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "repliedAt",
        e."fingerprint" as "eventFingerprint", e."type" as "eventType", e."payload" as "eventPayload"
      from entity m cross join selected_event e limit 1
    `);
    const row = one(executionRows(result), 'Inbox reply');
    assertEventReplayMatches(row, event);
    const message = mapInboxMessageRow(withoutEventMetadata(row));
    if (!sameJson(message.reply, request.reply)) {
      throw new EventFingerprintConflictError(event.runId, event.eventId);
    }
    return message;
  }

  async listEvents(
    runId: WorkflowRunId,
    page: ListPage<number> = {},
  ): Promise<readonly DomainEvent[]> {
    return mappedRows(
      await this.database
        .select(domainEventSelection)
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.runId, runId),
            page.after === undefined
              ? undefined
              : gt(domainEvents.sequence, page.after),
          ),
        )
        .orderBy(asc(domainEvents.sequence))
        .limit(boundedListLimit(page.limit)),
      mapDomainEventRow,
    );
  }

  async createArtifact(artifact: ArtifactRecord): Promise<ArtifactRecord> {
    assertValidArtifact(artifact);
    return mappedOne(
      await this.database
        .insert(artifacts)
        .values(artifact)
        .returning(artifactSelection),
      'Artifact',
      mapArtifactRow,
    );
  }

  async getArtifact(id: ArtifactId): Promise<ArtifactRecord | undefined> {
    const [row] = await this.database
      .select(artifactSelection)
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .limit(1);
    return row === undefined ? undefined : mapArtifactRow(row);
  }

  async listArtifacts(
    runId: WorkflowRunId,
    page: ListPage<TimestampListCursor<ArtifactId>> = {},
  ): Promise<readonly ArtifactRecord[]> {
    return mappedRows(
      await this.database
        .select(artifactSelection)
        .from(artifacts)
        .where(
          and(
            eq(artifacts.runId, runId),
            afterTimestamp(artifacts.createdAt, artifacts.id, page.after),
          ),
        )
        .orderBy(asc(artifacts.createdAt), asc(bytewiseText(artifacts.id)))
        .limit(boundedListLimit(page.limit)),
      mapArtifactRow,
    );
  }

  async appendUsage(usage: UsageRecordEntry): Promise<UsageRecordEntry> {
    assertValidUsage(usage);
    const result = await this.database.execute<Record<string, unknown>>(sql`
      insert into "usage_records"
        ("idempotency_id", "run_id", "step_run_id", "model", "input_tokens", "output_tokens", "runtime_ms", "microdollars", "recorded_at")
      values
        (${usage.idempotencyId}, ${usage.runId}, ${usage.stepRunId ?? null}, ${usage.model}, ${usage.inputTokens}, ${usage.outputTokens}, ${usage.runtimeMs}, ${usage.microdollars}, ${usage.recordedAt})
      on conflict ("idempotency_id") do update
        set "idempotency_id" = "usage_records"."idempotency_id"
      returning
        "idempotency_id" as "idempotencyId",
        "run_id" as "runId",
        "step_run_id" as "stepRunId",
        "model",
        "input_tokens"::text as "inputTokens",
        "output_tokens"::text as "outputTokens",
        "runtime_ms"::text as "runtimeMs",
        "microdollars"::text as "microdollars",
        to_char("recorded_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt"
    `);
    const usageRow = one(executionRows(result), 'Usage record');
    const existing = mapUsageRecordRow({
      ...usageRow,
      inputTokens: databaseSafeInteger(usageRow.inputTokens, 'inputTokens'),
      outputTokens: databaseSafeInteger(usageRow.outputTokens, 'outputTokens'),
      runtimeMs: databaseSafeInteger(usageRow.runtimeMs, 'runtimeMs'),
      microdollars: databaseSafeInteger(usageRow.microdollars, 'microdollars'),
    });
    if (!usageMatches(existing, usage)) {
      throw new IdempotencyConflictError('Usage record', usage.idempotencyId);
    }
    return existing;
  }

  async listUsage(
    runId: WorkflowRunId,
    page: ListPage<TimestampListCursor<UsageId>> = {},
  ): Promise<readonly UsageRecordEntry[]> {
    return mappedRows(
      await this.database
        .select(usageRecordSelection)
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.runId, runId),
            afterTimestamp(
              usageRecords.recordedAt,
              usageRecords.idempotencyId,
              page.after,
            ),
          ),
        )
        .orderBy(
          asc(usageRecords.recordedAt),
          asc(bytewiseText(usageRecords.idempotencyId)),
        )
        .limit(boundedListLimit(page.limit)),
      mapUsageRecordRow,
    );
  }

  async claimWebhook(receipt: WebhookReceipt): Promise<WebhookClaim> {
    const claimToken = this.createClaimToken();
    const result = await this.database.execute<Record<string, unknown>>(sql`
      insert into "webhook_receipts"
        ("source", "delivery_id", "fingerprint", "claim_token", "received_at", "expires_at")
      values
        (${receipt.source}, ${receipt.deliveryId}, ${receipt.fingerprint}, ${claimToken}, ${receipt.receivedAt}, ${receipt.expiresAt})
      on conflict ("source", "delivery_id") do update
        set "fingerprint" = "webhook_receipts"."fingerprint"
      returning
        "source",
        "delivery_id" as "deliveryId",
        "fingerprint",
        "claim_token" as "claimToken",
        to_char("received_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "receivedAt",
        to_char("expires_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt"
    `);
    const raw = one(executionRows(result), 'Webhook receipt');
    const { claimToken: storedClaimToken, ...receiptRow } = raw;
    const existing = mapWebhookReceiptRow(receiptRow);
    if (existing.fingerprint !== receipt.fingerprint) {
      throw new IdempotencyConflictError('Webhook receipt', receipt.deliveryId);
    }
    return { claimed: storedClaimToken === claimToken, receipt: existing };
  }

  async createGoalCriterion(criterion: GoalCriterion): Promise<GoalCriterion> {
    assertValidGoalCriterion(criterion);
    return mappedOne(
      await this.database
        .insert(goalCriteria)
        .values(criterion)
        .returning(goalCriterionSelection),
      'Goal criterion',
      mapGoalCriterionRow,
    );
  }

  async listGoalCriteria(
    runId: WorkflowRunId,
    page: ListPage<number> = {},
  ): Promise<readonly GoalCriterion[]> {
    return mappedRows(
      await this.database
        .select(goalCriterionSelection)
        .from(goalCriteria)
        .where(
          and(
            eq(goalCriteria.runId, runId),
            page.after === undefined
              ? undefined
              : gt(goalCriteria.ordinal, page.after),
          ),
        )
        .orderBy(asc(goalCriteria.ordinal))
        .limit(boundedListLimit(page.limit)),
      mapGoalCriterionRow,
    );
  }

  async appendGoalProgress(progress: GoalProgress): Promise<GoalProgress> {
    return mappedOne(
      await this.database
        .insert(goalProgress)
        .values({
          ...progress,
          payload: optionalJsonbValue(progress.payload),
        })
        .returning(goalProgressSelection),
      'Goal progress',
      mapGoalProgressRow,
    );
  }

  async listGoalProgress(
    runId: WorkflowRunId,
    page: ListPage<TimestampListCursor<GoalProgressId>> = {},
  ): Promise<readonly GoalProgress[]> {
    return mappedRows(
      await this.database
        .select(goalProgressSelection)
        .from(goalProgress)
        .where(
          and(
            eq(goalProgress.runId, runId),
            afterTimestamp(
              goalProgress.recordedAt,
              goalProgress.id,
              page.after,
            ),
          ),
        )
        .orderBy(
          asc(goalProgress.recordedAt),
          asc(bytewiseText(goalProgress.id)),
        )
        .limit(boundedListLimit(page.limit)),
      mapGoalProgressRow,
    );
  }
}

export function createNeonDomainRepository(
  databaseUrl: string,
): DomainRepository {
  const validatedUrl = databaseUrlFromEnv({ DATABASE_URL: databaseUrl });
  const client = neon(validatedUrl);
  const query = client.query.bind(client);
  client.query = ((queryText, params, options) =>
    query(queryText, params, {
      ...options,
      types: timestampTypeParsers,
    })) as typeof client.query;
  return new NeonDomainRepository(drizzle(client, { schema }));
}

export function createNeonDomainRepositoryFromEnv(
  environment: DatabaseEnvironment,
): DomainRepository {
  return createNeonDomainRepository(databaseUrlFromEnv(environment));
}
