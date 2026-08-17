import { neon, types } from '@neondatabase/serverless';
import { isoTimestampEpochMicroseconds } from '@agentos/core';
import type {
  Approval,
  ApprovalId,
  ArtifactId,
  ArtifactRecord,
  ConfigRevision,
  ConfigRevisionId,
  ConfigSnapshot,
  ConfigSnapshotId,
  ConsumeApprovalRequest,
  DomainEvent,
  DomainRepository,
  ExternalSession,
  ExternalSessionId,
  GoalCriterion,
  GoalProgress,
  InboxMessage,
  InboxMessageId,
  Project,
  ProjectId,
  ReplyInboxMessageRequest,
  RunListFilter,
  StepRun,
  StepRunId,
  UsageRecordEntry,
  WebhookClaim,
  WebhookReceipt,
  WorkflowRun,
  WorkflowRunId,
  WorkflowRunUpdate,
} from '@agentos/core';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
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
import { assertValidUsage } from './validation.js';

type Database = NeonHttpDatabase<typeof schema>;

function one<T>(rows: readonly T[], description: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${description} was not returned`);
  return row;
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

function jsonbValue(value: unknown) {
  return value === undefined ? sql`null` : sql`${JSON.stringify(value)}::jsonb`;
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
  public constructor(private readonly database: Database) {}

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

  async listProjects(): Promise<readonly Project[]> {
    return mappedRows(
      await this.database
        .select(projectSelection)
        .from(projects)
        .orderBy(asc(projects.createdAt)),
      mapProjectRow,
    );
  }

  async createConfigRevision(
    revision: ConfigRevision,
  ): Promise<ConfigRevision> {
    return mappedOne(
      await this.database
        .insert(configRevisions)
        .values(revision)
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
  ): Promise<readonly ConfigRevision[]> {
    return mappedRows(
      await this.database
        .select(configRevisionSelection)
        .from(configRevisions)
        .where(eq(configRevisions.projectId, projectId))
        .orderBy(asc(configRevisions.revision)),
      mapConfigRevisionRow,
    );
  }

  async createConfigSnapshot(
    snapshot: ConfigSnapshot,
  ): Promise<ConfigSnapshot> {
    return mappedOne(
      await this.database
        .insert(configSnapshots)
        .values(snapshot)
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
  ): Promise<readonly ConfigSnapshot[]> {
    return mappedRows(
      await this.database
        .select(configSnapshotSelection)
        .from(configSnapshots)
        .where(eq(configSnapshots.runId, runId))
        .orderBy(asc(configSnapshots.createdAt)),
      mapConfigSnapshotRow,
    );
  }

  async createRun(run: WorkflowRun): Promise<WorkflowRun> {
    return mappedOne(
      await this.database
        .insert(workflowRuns)
        .values(run)
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
          ),
        )
        .orderBy(asc(workflowRuns.createdAt)),
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
        .set(update)
        .where(eq(workflowRuns.id, id))
        .returning(workflowRunSelection),
      `Run ${id}`,
      mapWorkflowRunRow,
    );
  }

  async upsertStepRun(step: StepRun): Promise<StepRun> {
    const rows = await this.database
      .insert(stepRuns)
      .values(step)
      .onConflictDoUpdate({
        target: [stepRuns.runId, stepRuns.stepKey, stepRuns.attempt],
        set: {
          status: step.status,
          input: step.input,
          output: step.output,
          error: step.error,
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

  async listStepRuns(runId: WorkflowRunId): Promise<readonly StepRun[]> {
    return mappedRows(
      await this.database
        .select(stepRunSelection)
        .from(stepRuns)
        .where(eq(stepRuns.runId, runId))
        .orderBy(asc(stepRuns.stepKey), asc(stepRuns.attempt)),
      mapStepRunRow,
    );
  }

  async createExternalSession(
    session: ExternalSession,
  ): Promise<ExternalSession> {
    return mappedOne(
      await this.database
        .insert(externalSessions)
        .values(session)
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
  ): Promise<readonly ExternalSession[]> {
    return mappedRows(
      await this.database
        .select(externalSessionSelection)
        .from(externalSessions)
        .where(eq(externalSessions.runId, runId))
        .orderBy(asc(externalSessions.createdAt)),
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

  async listApprovals(runId: WorkflowRunId): Promise<readonly Approval[]> {
    return mappedRows(
      await this.database
        .select(approvalSelection)
        .from(approvals)
        .where(eq(approvals.runId, runId))
        .orderBy(asc(approvals.createdAt)),
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
        .values(message)
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
  ): Promise<readonly InboxMessage[]> {
    return mappedRows(
      await this.database
        .select(inboxMessageSelection)
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.runId, runId),
            status === undefined ? undefined : eq(inboxMessages.status, status),
          ),
        )
        .orderBy(asc(inboxMessages.createdAt)),
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
        reply: request.reply,
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

  async appendEvent(event: DomainEvent): Promise<DomainEvent> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      insert into "domain_events"
        ("run_id", "event_id", "fingerprint", "sequence", "type", "payload", "occurred_at")
      values
        (${event.runId}, ${event.eventId}, ${event.fingerprint}, ${event.sequence}, ${event.type}, ${jsonbValue(event.payload)}, ${event.occurredAt})
      on conflict ("run_id", "event_id") do update
        set "fingerprint" = "domain_events"."fingerprint"
      returning
        "run_id" as "runId",
        "event_id" as "eventId",
        "fingerprint",
        "sequence"::float8 as "sequence",
        "type",
        "payload",
        ("payload" is not null) as "payloadPresent",
        to_char("occurred_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt"
    `);
    const existing = mapDomainEventRow(one(result.rows, 'Event'));
    if (existing.fingerprint !== event.fingerprint) {
      throw new EventFingerprintConflictError(event.runId, event.eventId);
    }
    return existing;
  }

  async listEvents(runId: WorkflowRunId): Promise<readonly DomainEvent[]> {
    return mappedRows(
      await this.database
        .select(domainEventSelection)
        .from(domainEvents)
        .where(eq(domainEvents.runId, runId))
        .orderBy(asc(domainEvents.sequence)),
      mapDomainEventRow,
    );
  }

  async createArtifact(artifact: ArtifactRecord): Promise<ArtifactRecord> {
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
  ): Promise<readonly ArtifactRecord[]> {
    return mappedRows(
      await this.database
        .select(artifactSelection)
        .from(artifacts)
        .where(eq(artifacts.runId, runId))
        .orderBy(asc(artifacts.createdAt)),
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
        "input_tokens"::float8 as "inputTokens",
        "output_tokens"::float8 as "outputTokens",
        "runtime_ms"::float8 as "runtimeMs",
        "microdollars"::float8 as "microdollars",
        to_char("recorded_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt"
    `);
    const existing = mapUsageRecordRow(one(result.rows, 'Usage record'));
    if (!usageMatches(existing, usage)) {
      throw new IdempotencyConflictError('Usage record', usage.idempotencyId);
    }
    return existing;
  }

  async listUsage(runId: WorkflowRunId): Promise<readonly UsageRecordEntry[]> {
    return mappedRows(
      await this.database
        .select(usageRecordSelection)
        .from(usageRecords)
        .where(eq(usageRecords.runId, runId))
        .orderBy(asc(usageRecords.recordedAt)),
      mapUsageRecordRow,
    );
  }

  async claimWebhook(receipt: WebhookReceipt): Promise<WebhookClaim> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      insert into "webhook_receipts"
        ("source", "delivery_id", "fingerprint", "received_at", "expires_at")
      values
        (${receipt.source}, ${receipt.deliveryId}, ${receipt.fingerprint}, ${receipt.receivedAt}, ${receipt.expiresAt})
      on conflict ("source", "delivery_id") do update
        set "fingerprint" = "webhook_receipts"."fingerprint"
      returning
        "source",
        "delivery_id" as "deliveryId",
        "fingerprint",
        to_char("received_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "receivedAt",
        to_char("expires_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
        (xmax = 0) as "claimed"
    `);
    const raw = one(result.rows, 'Webhook receipt');
    const { claimed, ...receiptRow } = raw;
    const existing = mapWebhookReceiptRow(receiptRow);
    if (existing.fingerprint !== receipt.fingerprint) {
      throw new IdempotencyConflictError('Webhook receipt', receipt.deliveryId);
    }
    return { claimed: claimed === true, receipt: existing };
  }

  async createGoalCriterion(criterion: GoalCriterion): Promise<GoalCriterion> {
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
  ): Promise<readonly GoalCriterion[]> {
    return mappedRows(
      await this.database
        .select(goalCriterionSelection)
        .from(goalCriteria)
        .where(eq(goalCriteria.runId, runId))
        .orderBy(asc(goalCriteria.ordinal)),
      mapGoalCriterionRow,
    );
  }

  async appendGoalProgress(progress: GoalProgress): Promise<GoalProgress> {
    return mappedOne(
      await this.database
        .insert(goalProgress)
        .values(progress)
        .returning(goalProgressSelection),
      'Goal progress',
      mapGoalProgressRow,
    );
  }

  async listGoalProgress(
    runId: WorkflowRunId,
  ): Promise<readonly GoalProgress[]> {
    return mappedRows(
      await this.database
        .select(goalProgressSelection)
        .from(goalProgress)
        .where(eq(goalProgress.runId, runId))
        .orderBy(asc(goalProgress.recordedAt)),
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
