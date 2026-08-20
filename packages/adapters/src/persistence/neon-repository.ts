import { randomUUID } from 'node:crypto';

import { neon, types } from '@neondatabase/serverless';
import {
  ARTIFACT_CAPABILITY_MAX_CALLS,
  ARTIFACT_CAPABILITY_MAX_CUMULATIVE_BYTES,
  canonicalJsonValue,
  isoTimestamp,
  isoTimestampEpochMicroseconds,
} from '@agentos/core';
import type {
  Approval,
  ApprovalId,
  ApprovalListFilter,
  ArtifactId,
  ArtifactCapabilityQuotaRequest,
  ArtifactCapabilityQuotaResult,
  ArtifactCleanupLeaseRequest,
  ArtifactDeletionFinalizationRequest,
  ArtifactDeletionReservationRequest,
  ArtifactRecord,
  ArtifactWriteClaimRequest,
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
  ExternalSessionUpdate,
  GoalCriterion,
  GoalProgress,
  GoalProgressId,
  InboxMessage,
  InboxMessageId,
  IsoTimestamp,
  JsonValue,
  ListPage,
  Project,
  ProjectId,
  ReplyInboxMessageRequest,
  RunListFilter,
  RunStatus,
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
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
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
  assertValidGoalProgress,
  assertValidStepRun,
  assertValidUsage,
  sameGoalCriterion,
  sameGoalProgress,
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

function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === '23505'
  );
}

function validateArtifactQuotaRequest(
  request: ArtifactCapabilityQuotaRequest,
): void {
  for (const [name, value] of [
    ['purpose', request.purpose],
    ['audience', request.audience],
    ['nonce', request.nonce],
    ['fingerprint', request.fingerprint],
    ['operationId', request.operationId],
  ] as const) {
    if (value.trim() === '' || value.length > 256)
      throw new TypeError(`${name} is invalid`);
  }
  for (const [name, value, positive] of [
    ['bytes', request.bytes, false],
    ['maxCalls', request.maxCalls, true],
    ['maxCumulativeBytes', request.maxCumulativeBytes, true],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
      throw new TypeError(`${name} is invalid`);
  }
  if (request.maxCalls > ARTIFACT_CAPABILITY_MAX_CALLS)
    throw new TypeError('maxCalls is invalid');
  if (request.maxCumulativeBytes > ARTIFACT_CAPABILITY_MAX_CUMULATIVE_BYTES)
    throw new TypeError('maxCumulativeBytes is invalid');
  isoTimestamp(request.notBefore);
  isoTimestamp(request.expiresAt);
  isoTimestamp(request.now);
}

function usageMatches(row: UsageRecordEntry, usage: UsageRecordEntry): boolean {
  return (
    row.idempotencyId === usage.idempotencyId &&
    row.runId === usage.runId &&
    row.stepRunId === usage.stepRunId &&
    row.model === usage.model &&
    row.pricingVersion === usage.pricingVersion &&
    row.inputTokens === usage.inputTokens &&
    row.outputTokens === usage.outputTokens &&
    row.cacheReadInputTokens === usage.cacheReadInputTokens &&
    row.cacheCreation5mInputTokens === usage.cacheCreation5mInputTokens &&
    row.cacheCreation1hInputTokens === usage.cacheCreation1hInputTokens &&
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
        with "idempotency_lock" as materialized (
          select pg_advisory_xact_lock(hashtextextended(${revision.id}, 0)) as "held"
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
          where "active"."project_id" = ${project.id}
          order by "active"."created_at" desc, "active"."revision" desc,
                   "active"."id" collate "C" desc
          limit 1
        ),
        "precondition" as materialized (
          select case
            when ${precondition === undefined} then true
            when ${precondition?.revision ?? null}::integer is null then
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

  async getLatestConfigRevision(
    projectId: ProjectId,
  ): Promise<ConfigRevision | undefined> {
    const [row] = await this.database
      .select(configRevisionSelection)
      .from(configRevisions)
      .where(eq(configRevisions.projectId, projectId))
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
    if (filter.order === 'desc' && filter.after !== undefined)
      throw new TypeError('descending run listing does not support cursors');
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
          ...(filter.order === 'desc'
            ? [
                desc(workflowRuns.createdAt),
                desc(bytewiseText(workflowRuns.id)),
              ]
            : [
                asc(workflowRuns.createdAt),
                asc(bytewiseText(workflowRuns.id)),
              ]),
        )
        .limit(boundedListLimit(filter.limit)),
      mapWorkflowRunRow,
    );
  }

  async countRuns(
    filter: Pick<RunListFilter, 'projectId' | 'status'> = {},
  ): Promise<number> {
    const [row] = await this.database
      .select({ total: sql<string>`count(*)` })
      .from(workflowRuns)
      .where(
        and(
          filter.projectId === undefined
            ? undefined
            : eq(workflowRuns.projectId, filter.projectId),
          filter.status === undefined
            ? undefined
            : eq(workflowRuns.status, filter.status),
        ),
      );
    // count(*) is bigint; the driver hands it back as a string.
    return Number(row?.total ?? 0);
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
          stateVersion: sql`${workflowRuns.stateVersion} + 1`,
          output: optionalJsonbValue(update.output),
          error: optionalJsonbValue(update.error),
        })
        .where(eq(workflowRuns.id, id))
        .returning(workflowRunSelection),
      `Run ${id}`,
      mapWorkflowRunRow,
    );
  }

  async transitionRun(
    id: WorkflowRunId,
    expectedStatuses: readonly RunStatus[],
    update: WorkflowRunUpdate,
    expectedVersion?: number,
  ): Promise<WorkflowRun | undefined> {
    if (expectedStatuses.length === 0) return undefined;
    const [row] = await this.database
      .update(workflowRuns)
      .set({
        ...update,
        stateVersion: sql`${workflowRuns.stateVersion} + 1`,
        output: optionalJsonbValue(update.output),
        error: optionalJsonbValue(update.error),
      })
      .where(
        and(
          eq(workflowRuns.id, id),
          inArray(workflowRuns.status, [...expectedStatuses]),
          expectedVersion === undefined
            ? undefined
            : eq(workflowRuns.stateVersion, expectedVersion),
        ),
      )
      .returning(workflowRunSelection);
    return row === undefined ? undefined : mapWorkflowRunRow(row);
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

  async updateExternalSession(
    id: ExternalSessionId,
    update: ExternalSessionUpdate,
  ): Promise<ExternalSession> {
    return mappedOne(
      await this.database
        .update(externalSessions)
        .set({ ...update, state: optionalJsonbValue(update.state) })
        .where(eq(externalSessions.id, id))
        .returning(externalSessionSelection),
      `External session ${id}`,
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

  async expireApproval(
    id: ApprovalId,
    binding: {
      readonly runId: WorkflowRunId;
      readonly scope: string;
      readonly fingerprint: string;
      readonly at: IsoTimestamp;
    },
  ): Promise<Approval | undefined> {
    const rows = await this.database
      .update(approvals)
      .set({ status: 'expired' })
      .where(
        and(
          eq(approvals.id, id),
          eq(approvals.runId, binding.runId),
          eq(approvals.scope, binding.scope),
          eq(approvals.fingerprint, binding.fingerprint),
          eq(approvals.status, 'pending'),
          lte(approvals.expiresAt, binding.at),
        ),
      )
      .returning(approvalSelection);
    return rows[0] === undefined ? undefined : mapApprovalRow(rows[0]);
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

  async claimArtifact(artifact: ArtifactRecord): Promise<ArtifactRecord> {
    assertValidArtifact(artifact);
    const [claimed] = await this.database
      .insert(artifacts)
      .values(artifact)
      .onConflictDoNothing({ target: [artifacts.runId, artifacts.key] })
      .returning(artifactSelection);
    if (claimed !== undefined) return mapArtifactRow(claimed);
    const existing = await this.getArtifactByRunKey(
      artifact.runId,
      artifact.key,
    );
    if (existing === undefined)
      throw new Error('Artifact claim could not be reconciled');
    return existing;
  }

  async claimArtifactForWrite(
    request: ArtifactWriteClaimRequest,
  ): Promise<ArtifactRecord> {
    const artifact = request.artifact;
    assertValidArtifact(artifact);
    if (
      request.leaseId.trim() === '' ||
      isoTimestampEpochMicroseconds(request.expiresAt) <=
        isoTimestampEpochMicroseconds(request.now)
    )
      throw new TypeError('artifact write lease is invalid');
    const [claimed] = await this.database
      .insert(artifacts)
      .values({
        ...artifact,
        deletionState: 'active',
        writeLeaseId: request.leaseId,
        writeLeaseExpiresAt: request.expiresAt,
      })
      .onConflictDoUpdate({
        target: [artifacts.runId, artifacts.key],
        set: {
          writeLeaseId: request.leaseId,
          writeLeaseExpiresAt: request.expiresAt,
        },
        setWhere: and(
          eq(artifacts.id, artifact.id),
          eq(artifacts.digest, artifact.digest),
          eq(artifacts.uri, artifact.uri!),
          eq(artifacts.mediaType, artifact.mediaType!),
          eq(artifacts.sizeBytes, artifact.sizeBytes!),
          eq(artifacts.retentionClass, artifact.retentionClass!),
          eq(artifacts.createdAt, artifact.createdAt),
          eq(artifacts.cleanupAt, artifact.cleanupAt!),
          eq(artifacts.manifestVersion, 'artifact-manifest-v1'),
          eq(artifacts.deletionState, 'active'),
          isNull(artifacts.deletedAt),
          or(
            isNull(artifacts.writeLeaseExpiresAt),
            lte(artifacts.writeLeaseExpiresAt, request.now),
            eq(artifacts.writeLeaseId, request.leaseId),
          ),
        )!,
      })
      .returning(artifactSelection);
    if (claimed !== undefined) return mapArtifactRow(claimed);
    const existing = await this.getArtifactByRunKey(
      artifact.runId,
      artifact.key,
    );
    if (existing === undefined)
      throw new Error('Artifact write claim could not be reconciled');
    return existing;
  }

  async releaseArtifactWriteLease(
    id: ArtifactId,
    leaseId: string,
  ): Promise<void> {
    await this.database
      .update(artifacts)
      .set({ writeLeaseId: null, writeLeaseExpiresAt: null })
      .where(and(eq(artifacts.id, id), eq(artifacts.writeLeaseId, leaseId)));
  }

  async getArtifact(id: ArtifactId): Promise<ArtifactRecord | undefined> {
    const [row] = await this.database
      .select(artifactSelection)
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .limit(1);
    return row === undefined ? undefined : mapArtifactRow(row);
  }

  async getArtifactByRunKey(
    runId: WorkflowRunId,
    key: string,
  ): Promise<ArtifactRecord | undefined> {
    const [row] = await this.database
      .select(artifactSelection)
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.key, key)))
      .limit(1);
    return row === undefined ? undefined : mapArtifactRow(row);
  }

  async listArtifactsByRunKey(
    runId: WorkflowRunId,
    keyPrefix: string,
    afterKey: string | undefined,
    limit: number,
  ): Promise<readonly ArtifactRecord[]> {
    return mappedRows(
      await this.database
        .select(artifactSelection)
        .from(artifacts)
        .where(
          and(
            eq(artifacts.runId, runId),
            isNull(artifacts.deletedAt),
            eq(artifacts.manifestVersion, 'artifact-manifest-v1'),
            eq(artifacts.deletionState, 'active'),
            sql`left(${artifacts.key}, ${keyPrefix.length}) = ${keyPrefix}`,
            afterKey === undefined
              ? undefined
              : gt(bytewiseText(artifacts.key), afterKey),
          ),
        )
        .orderBy(asc(bytewiseText(artifacts.key)))
        .limit(limit),
      mapArtifactRow,
    );
  }

  async listArtifactsDueForCleanup(
    before: import('@agentos/core').IsoTimestamp,
    limit: number,
  ): Promise<readonly ArtifactRecord[]> {
    return mappedRows(
      await this.database
        .select(artifactSelection)
        .from(artifacts)
        .where(
          and(
            isNull(artifacts.deletedAt),
            eq(artifacts.manifestVersion, 'artifact-manifest-v1'),
            or(
              eq(artifacts.deletionState, 'active'),
              eq(artifacts.deletionState, 'pending'),
            ),
            sql`${artifacts.cleanupAt} is not null`,
            lte(artifacts.cleanupAt, before),
          ),
        )
        .orderBy(asc(artifacts.cleanupAt), asc(bytewiseText(artifacts.id)))
        .limit(limit),
      mapArtifactRow,
    );
  }

  async reserveArtifactDeletion(
    request: ArtifactDeletionReservationRequest,
  ): Promise<ArtifactRecord | undefined> {
    const [reserved] = await this.database
      .update(artifacts)
      .set({
        deletionState: 'pending',
        deletionRequestedAt: request.requestedAt,
        deletionReason: request.reason,
      })
      .where(
        and(
          eq(artifacts.id, request.id),
          eq(artifacts.runId, request.runId),
          eq(artifacts.key, request.logicalKey),
          eq(artifacts.uri, request.uri),
          eq(artifacts.digest, request.digest),
          eq(artifacts.manifestVersion, 'artifact-manifest-v1'),
          or(
            eq(artifacts.deletionState, 'active'),
            eq(artifacts.deletionState, 'pending'),
          ),
          isNull(artifacts.deletedAt),
          or(
            isNull(artifacts.writeLeaseExpiresAt),
            lte(artifacts.writeLeaseExpiresAt, request.now),
          ),
        ),
      )
      .returning(artifactSelection);
    return reserved === undefined ? undefined : mapArtifactRow(reserved);
  }

  async finalizeArtifactDeletion(
    request: ArtifactDeletionFinalizationRequest,
  ): Promise<ArtifactRecord> {
    const [finalized] = await this.database
      .update(artifacts)
      .set({
        deletionState: 'deleted',
        deletedAt: request.deletedAt,
        deletionReason: request.reason,
        writeLeaseId: null,
        writeLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(artifacts.id, request.id),
          eq(artifacts.runId, request.runId),
          eq(artifacts.key, request.logicalKey),
          eq(artifacts.uri, request.uri),
          eq(artifacts.digest, request.digest),
          eq(artifacts.manifestVersion, 'artifact-manifest-v1'),
          eq(artifacts.deletionState, 'pending'),
          isNull(artifacts.deletedAt),
        ),
      )
      .returning(artifactSelection);
    if (finalized !== undefined) return mapArtifactRow(finalized);
    const existing = await this.getArtifact(request.id);
    if (
      existing === undefined ||
      existing.deletionState !== 'deleted' ||
      existing.runId !== request.runId ||
      existing.key !== request.logicalKey ||
      existing.uri !== request.uri ||
      existing.digest !== request.digest
    )
      throw new Error('Artifact deletion could not be finalized');
    return existing;
  }

  async consumeArtifactCapabilityQuota(
    request: ArtifactCapabilityQuotaRequest,
  ): Promise<ArtifactCapabilityQuotaResult> {
    validateArtifactQuotaRequest(request);
    if (
      isoTimestampEpochMicroseconds(request.now) <
        isoTimestampEpochMicroseconds(request.notBefore) ||
      isoTimestampEpochMicroseconds(request.now) >=
        isoTimestampEpochMicroseconds(request.expiresAt)
    )
      return { allowed: false, replayed: false, calls: 0, cumulativeBytes: 0 };
    const result = await this.database.execute<Record<string, unknown>>(sql`
      insert into "artifact_capability_quotas"
        ("purpose", "audience", "nonce", "fingerprint", "not_before", "expires_at", "calls", "cumulative_bytes", "updated_at")
      select
        ${request.purpose}, ${request.audience}, ${request.nonce}, ${request.fingerprint}, ${request.notBefore}, ${request.expiresAt}, 1, ${request.bytes}, ${request.now}
      where ${request.maxCalls}::integer >= 1
        and ${request.bytes}::bigint <= ${request.maxCumulativeBytes}::bigint
      on conflict ("purpose", "audience", "nonce") do update set
        "calls" = "artifact_capability_quotas"."calls" + 1,
        "cumulative_bytes" = "artifact_capability_quotas"."cumulative_bytes" + ${request.bytes},
        "updated_at" = ${request.now}
      where
        "artifact_capability_quotas"."fingerprint" = ${request.fingerprint}
        and "artifact_capability_quotas"."not_before" = ${request.notBefore}
        and "artifact_capability_quotas"."expires_at" = ${request.expiresAt}
        and "artifact_capability_quotas"."calls" + 1 <= ${request.maxCalls}
        and "artifact_capability_quotas"."cumulative_bytes" + ${request.bytes} <= ${request.maxCumulativeBytes}
      returning
        "calls", "cumulative_bytes"
    `);
    const row = executionRows(result)[0];
    if (row !== undefined)
      return {
        allowed: true,
        replayed: row.replayed === true,
        calls: Number(row.calls),
        cumulativeBytes: Number(row.cumulative_bytes),
      };
    const current = executionRows(
      await this.database.execute<Record<string, unknown>>(sql`
        select "calls", "cumulative_bytes"
        from "artifact_capability_quotas"
        where "purpose" = ${request.purpose}
          and "audience" = ${request.audience}
          and "nonce" = ${request.nonce}
        limit 1
      `),
    )[0];
    return {
      allowed: false,
      replayed: false,
      calls: Number(current?.calls ?? 0),
      cumulativeBytes: Number(current?.cumulative_bytes ?? 0),
    };
  }

  async claimArtifactCleanupLease(
    request: ArtifactCleanupLeaseRequest,
  ): Promise<boolean> {
    if (request.owner.trim() === '' || request.owner.length > 256)
      throw new TypeError('cleanup lease owner is invalid');
    if (
      isoTimestampEpochMicroseconds(request.expiresAt) <=
      isoTimestampEpochMicroseconds(request.now)
    )
      throw new TypeError('cleanup lease expiry must be after now');
    const rows = executionRows(
      await this.database.execute<Record<string, unknown>>(sql`
        insert into "artifact_cleanup_leases"
          ("name", "owner", "expires_at", "updated_at")
        values ('artifact-retention', ${request.owner}, ${request.expiresAt}, ${request.now})
        on conflict ("name") do update set
          "owner" = excluded."owner",
          "expires_at" = excluded."expires_at",
          "updated_at" = excluded."updated_at"
        where "artifact_cleanup_leases"."expires_at" <= ${request.now}
        returning "name"
      `),
    );
    return rows.length === 1;
  }

  async renewArtifactCleanupLease(
    request: ArtifactCleanupLeaseRequest,
  ): Promise<boolean> {
    if (request.owner.trim() === '' || request.owner.length > 256)
      throw new TypeError('cleanup lease owner is invalid');
    if (
      isoTimestampEpochMicroseconds(request.expiresAt) <=
      isoTimestampEpochMicroseconds(request.now)
    )
      throw new TypeError('cleanup lease expiry must be after now');
    const rows = executionRows(
      await this.database.execute<Record<string, unknown>>(sql`
        update "artifact_cleanup_leases"
        set "expires_at" = ${request.expiresAt},
            "updated_at" = ${request.now}
        where "name" = 'artifact-retention'
          and "owner" = ${request.owner}
          and "expires_at" > ${request.now}
        returning "name"
      `),
    );
    return rows.length === 1;
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
        ("idempotency_id", "run_id", "step_run_id", "model", "pricing_version", "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_5m_input_tokens", "cache_creation_1h_input_tokens", "runtime_ms", "microdollars", "recorded_at")
      values
        (${usage.idempotencyId}, ${usage.runId}, ${usage.stepRunId ?? null}, ${usage.model}, ${usage.pricingVersion}, ${usage.inputTokens}, ${usage.outputTokens}, ${usage.cacheReadInputTokens}, ${usage.cacheCreation5mInputTokens}, ${usage.cacheCreation1hInputTokens}, ${usage.runtimeMs}, ${usage.microdollars}, ${usage.recordedAt})
      on conflict ("idempotency_id") do update
        set "idempotency_id" = "usage_records"."idempotency_id"
      returning
        "idempotency_id" as "idempotencyId",
        "run_id" as "runId",
        "step_run_id" as "stepRunId",
        "model",
        "pricing_version" as "pricingVersion",
        "input_tokens"::text as "inputTokens",
        "output_tokens"::text as "outputTokens",
        "cache_read_input_tokens"::text as "cacheReadInputTokens",
        "cache_creation_5m_input_tokens"::text as "cacheCreation5mInputTokens",
        "cache_creation_1h_input_tokens"::text as "cacheCreation1hInputTokens",
        "runtime_ms"::text as "runtimeMs",
        "microdollars"::text as "microdollars",
        to_char("recorded_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt"
    `);
    const usageRow = one(executionRows(result), 'Usage record');
    const existing = mapUsageRecordRow({
      ...usageRow,
      inputTokens: databaseSafeInteger(usageRow.inputTokens, 'inputTokens'),
      outputTokens: databaseSafeInteger(usageRow.outputTokens, 'outputTokens'),
      cacheReadInputTokens: databaseSafeInteger(
        usageRow.cacheReadInputTokens,
        'cacheReadInputTokens',
      ),
      cacheCreation5mInputTokens: databaseSafeInteger(
        usageRow.cacheCreation5mInputTokens,
        'cacheCreation5mInputTokens',
      ),
      cacheCreation1hInputTokens: databaseSafeInteger(
        usageRow.cacheCreation1hInputTokens,
        'cacheCreation1hInputTokens',
      ),
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

  async createGoalCriterionIdempotently(
    criterion: GoalCriterion,
  ): Promise<GoalCriterion> {
    assertValidGoalCriterion(criterion);
    try {
      const rows = await this.database
        .insert(goalCriteria)
        .values(criterion)
        .onConflictDoUpdate({
          target: goalCriteria.id,
          set: { id: criterion.id },
        })
        .returning(goalCriterionSelection);
      const existing = mapGoalCriterionRow(one(rows, 'Goal criterion'));
      if (!sameGoalCriterion(existing, criterion))
        throw new IdempotencyConflictError('Goal criterion', criterion.id);
      return existing;
    } catch (error) {
      if (isPostgresUniqueViolation(error))
        throw new IdempotencyConflictError(
          'Goal criterion ordinal',
          `${criterion.runId}:${String(criterion.ordinal)}`,
        );
      throw error;
    }
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
    assertValidGoalProgress(progress);
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

  async appendGoalProgressIdempotently(
    progress: GoalProgress,
  ): Promise<GoalProgress> {
    assertValidGoalProgress(progress);
    const rows = await this.database
      .insert(goalProgress)
      .values({
        ...progress,
        payload: optionalJsonbValue(progress.payload),
      })
      .onConflictDoUpdate({
        target: goalProgress.id,
        set: { id: progress.id },
      })
      .returning(goalProgressSelection);
    const existing = mapGoalProgressRow(one(rows, 'Goal progress'));
    if (!sameGoalProgress(existing, progress))
      throw new IdempotencyConflictError('Goal progress', progress.id);
    return existing;
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
