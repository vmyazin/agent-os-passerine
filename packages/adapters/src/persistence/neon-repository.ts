import { randomUUID } from 'node:crypto';

import { neon, types } from '@neondatabase/serverless';
import {
  canonicalJsonValue,
  isoTimestampEpochMicroseconds,
} from '@agentos/core';
import type {
  Approval,
  ApprovalId,
  ApprovalListFilter,
  ArtifactId,
  ArtifactRecord,
  ConfigRevision,
  ConfigRevisionDraft,
  ConfigRevisionPrecondition,
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
import { and, asc, desc, eq, gt, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';

import {
  databaseUrlFromEnv,
  type DatabaseEnvironment,
} from './database-config.js';
import {
  EventFingerprintConflictError,
  IdempotencyConflictError,
  StaleConfigurationError,
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

function configRevisionMatches(
  existing: ConfigRevision,
  requested: ConfigRevisionDraft,
): boolean {
  return (
    existing.id === requested.id &&
    existing.projectId === requested.projectId &&
    canonicalJsonValue(existing.config) ===
      canonicalJsonValue(requested.config) &&
    existing.configDigest === requested.configDigest &&
    existing.modelDigest === requested.modelDigest &&
    existing.promptDigest === requested.promptDigest &&
    existing.environmentDigest === requested.environmentDigest &&
    existing.policyDigest === requested.policyDigest &&
    existing.repositorySha === requested.repositorySha
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

function hasDatabaseError(error: unknown, message: string): boolean {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current))
      return false;
    seen.add(current);
    try {
      if (
        Reflect.get(current, 'code') === 'P0001' &&
        String(Reflect.get(current, 'message')).includes(message)
      ) {
        return true;
      }
      current = Reflect.get(current, 'cause');
    } catch {
      return false;
    }
  }
  return false;
}

function hasUniqueConstraint(error: unknown, constraint: string): boolean {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current))
      return false;
    seen.add(current);
    try {
      if (
        Reflect.get(current, 'code') === '23505' &&
        (Reflect.get(current, 'constraint') === constraint ||
          String(Reflect.get(current, 'message')).includes(constraint))
      ) {
        return true;
      }
      current = Reflect.get(current, 'cause');
    } catch {
      return false;
    }
  }
  return false;
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

  async applyConfigRevision(
    project: Project,
    revision: ConfigRevisionDraft,
    precondition?: ConfigRevisionPrecondition,
  ): Promise<ConfigRevision> {
    let result: unknown;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      try {
        result = await this.database.execute<Record<string, unknown>>(sql`
        with "global_configuration_lock" as materialized (
          select pg_advisory_xact_lock(hashtextextended('agentos:configuration', 0)) as "held"
        ),
        "idempotency_lock" as materialized (
          select pg_advisory_xact_lock(hashtextextended(${revision.id}, 0)) as "held"
          from "global_configuration_lock"
        ),
        "configuration_lock" as materialized (
          select pg_advisory_xact_lock(hashtextextended(${project.id}, 0)) as "held"
          from "idempotency_lock"
        ),
        "existing_revision" as materialized (
          select "existing".*
          from "config_revisions" as "existing", "configuration_lock"
          where "existing"."id" = ${revision.id}
        ),
        "active_revision" as materialized (
          select "active"."revision", "active"."config_digest"
          from "config_revisions" as "active", "configuration_lock"
          order by "active"."created_at" desc, "active"."revision" desc,
                   "active"."id" collate "C" desc
          limit 1
        ),
        "precondition" as materialized (
          select case
            when ${precondition === undefined} then true
            when ${precondition?.revision ?? null} is null then
              not exists (select 1 from "active_revision")
            else exists (
              select 1 from "active_revision"
              where "revision" = ${precondition?.revision ?? null}
                and "config_digest" = ${precondition?.digest ?? null}
            )
          end as "matches"
        ),
        "project_row" as (
          insert into "projects" ("id", "name", "repository", "created_at", "updated_at")
          select ${project.id}, ${project.name}, ${project.repository ?? null},
                 ${project.createdAt}, ${project.updatedAt}
          from "configuration_lock"
          where not exists (select 1 from "existing_revision")
            and (select "matches" from "precondition")
          on conflict ("id") do update set
            "name" = excluded."name",
            "repository" = excluded."repository",
            "updated_at" = excluded."updated_at"
          returning "id"
        ),
        "next_revision" as materialized (
          select coalesce(max("revision"), 0) + 1 as "revision"
          from "config_revisions", "project_row"
          where "project_id" = ${project.id}
        ),
        "inserted_revision" as (
          insert into "config_revisions" (
            "id", "project_id", "revision", "config", "config_digest",
            "model_digest", "prompt_digest", "environment_digest",
            "policy_digest", "repository_sha", "created_at"
          )
          select ${revision.id}, ${revision.projectId}, "next_revision"."revision",
                 ${jsonbValue(revision.config)}, ${revision.configDigest},
                 ${revision.modelDigest}, ${revision.promptDigest},
                 ${revision.environmentDigest}, ${revision.policyDigest},
                 ${revision.repositorySha}, ${revision.createdAt}
          from "project_row", "next_revision"
          returning *
        ),
        "revision_row" as (
          select * from "existing_revision"
          union all
          select * from "inserted_revision"
        )
        select
          "id", "project_id" as "projectId", "revision", "config",
          "config_digest" as "configDigest", "model_digest" as "modelDigest",
          "prompt_digest" as "promptDigest",
          "environment_digest" as "environmentDigest",
          "policy_digest" as "policyDigest", "repository_sha" as "repositorySha",
          to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
        from "revision_row"
      `);
        break;
      } catch (error) {
        const serializationConflict =
          hasUniqueConstraint(
            error,
            'config_revisions_project_revision_unique',
          ) || hasUniqueConstraint(error, 'config_revisions_pkey');
        if (serializationConflict && attempt < 31) continue;
        if (serializationConflict) {
          throw new Error('configuration revision could not be serialized', {
            cause: error,
          });
        }
        throw error;
      }
    }
    if (result === undefined)
      throw new Error('configuration revision was not returned');
    const rows = executionRows(result);
    if (rows.length === 0) throw new StaleConfigurationError();
    const created = mapConfigRevisionRow(one(rows, 'Config revision'));
    if (!configRevisionMatches(created, revision)) {
      throw new IdempotencyConflictError('Config revision', revision.id);
    }
    return created;
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

  async getLatestConfigRevision(): Promise<ConfigRevision | undefined> {
    const [row] = await this.database
      .select(configRevisionSelection)
      .from(configRevisions)
      .orderBy(
        desc(configRevisions.createdAt),
        desc(configRevisions.revision),
        desc(bytewiseText(configRevisions.id)),
      )
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

  async createRunIdempotently(
    run: WorkflowRun,
    idempotencyFingerprint: string,
  ): Promise<WorkflowRun> {
    const rows = await this.database
      .insert(workflowRuns)
      .values({
        ...run,
        idempotencyFingerprint,
        input: optionalJsonbValue(run.input),
        output: optionalJsonbValue(run.output),
        error: optionalJsonbValue(run.error),
      })
      .onConflictDoUpdate({
        target: workflowRuns.id,
        set: { id: run.id },
      })
      .returning(workflowRunSelection);
    const row = one(rows, 'Run');
    if (row.idempotencyFingerprint !== idempotencyFingerprint) {
      throw new IdempotencyConflictError('Run', run.id);
    }
    return mapWorkflowRunRow(row);
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
    let result: unknown;
    try {
      result = await this.database.execute<Record<string, unknown>>(sql`
        select
          "run_id" as "runId", "event_id" as "eventId", "fingerprint",
          "sequence"::text as "sequence", "type", "payload",
          ("payload" is not null) as "payloadPresent",
          to_char("occurred_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt"
        from "agentos_append_event"(
          ${event.runId}, ${event.eventId}, ${event.fingerprint}, ${event.type},
          ${nullableJsonbValue(event.payload)}, ${event.occurredAt}
        )
      `);
    } catch (error) {
      if (hasDatabaseError(error, 'agentos_event_conflict')) {
        throw new EventFingerprintConflictError(event.runId, event.eventId);
      }
      throw error;
    }
    const eventRow = one(executionRows(result), 'Event');
    return mapDomainEventRow({
      ...eventRow,
      sequence: databaseSafeInteger(eventRow.sequence, 'sequence'),
    });
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
    try {
      const result = await this.database.execute<Record<string, unknown>>(sql`
        select
          "id", "project_id" as "projectId", "config_revision_id" as "configRevisionId",
          "pipeline", "idempotency_fingerprint" as "idempotencyFingerprint", "status",
          "input", ("input" is not null) as "inputPresent",
          "output", ("output" is not null) as "outputPresent",
          "error", ("error" is not null) as "errorPresent",
          to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
          to_char("updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",
          to_char("started_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "startedAt",
          to_char("completed_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "completedAt",
          to_char("cleanup_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cleanupAt"
        from "agentos_cancel_run_with_event"(
          ${runId}, ${update.updatedAt}, ${update.completedAt ?? update.updatedAt},
          ${event.eventId}, ${event.fingerprint}, ${event.type},
          ${nullableJsonbValue(event.payload)}, ${event.occurredAt}
        )
      `);
      return mapWorkflowRunRow(one(executionRows(result), 'Cancelled run'));
    } catch (error) {
      if (hasDatabaseError(error, 'agentos_event_conflict')) {
        throw new EventFingerprintConflictError(event.runId, event.eventId);
      }
      throw error;
    }
  }

  async consumeApprovalWithEvent(
    request: ConsumeApprovalRequest,
    event: DomainEventDraft,
  ): Promise<Approval | undefined> {
    if (event.runId !== request.runId)
      throw new Error('event run does not match mutation');
    try {
      const result = await this.database.execute<Record<string, unknown>>(sql`
        select
          "id", "run_id" as "runId", "scope", "fingerprint", "status",
          to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
          to_char("expires_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
          to_char("consumed_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "consumedAt"
        from "agentos_consume_approval_with_event"(
          ${request.approvalId}, ${request.runId}, ${request.scope}, ${request.fingerprint},
          ${request.consumedAt}, ${event.eventId}, ${event.fingerprint}, ${event.type},
          ${nullableJsonbValue(event.payload)}, ${event.occurredAt}
        )
      `);
      const [row] = executionRows(result);
      return row === undefined ? undefined : mapApprovalRow(row);
    } catch (error) {
      if (hasDatabaseError(error, 'agentos_event_conflict')) {
        throw new EventFingerprintConflictError(event.runId, event.eventId);
      }
      throw error;
    }
  }

  async replyInboxMessageWithEvent(
    request: ReplyInboxMessageRequest,
    event: DomainEventDraft,
  ): Promise<InboxMessage> {
    try {
      const result = await this.database.execute<Record<string, unknown>>(sql`
        select
          "id", "run_id" as "runId", "step_run_id" as "stepRunId", "status",
          "body", "reply", ("reply" is not null) as "replyPresent",
          to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
          to_char("replied_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "repliedAt"
        from "agentos_reply_inbox_with_event"(
          ${request.messageId}, ${event.runId}, ${jsonbValue(request.reply)}, ${request.repliedAt},
          ${event.eventId}, ${event.fingerprint}, ${event.type},
          ${nullableJsonbValue(event.payload)}, ${event.occurredAt}
        )
      `);
      return mapInboxMessageRow(one(executionRows(result), 'Inbox reply'));
    } catch (error) {
      if (hasDatabaseError(error, 'agentos_event_conflict')) {
        throw new EventFingerprintConflictError(event.runId, event.eventId);
      }
      throw error;
    }
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
