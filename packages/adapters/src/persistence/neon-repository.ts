import { neon } from '@neondatabase/serverless';
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
import { and, asc, eq, gt } from 'drizzle-orm';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';

import {
  databaseUrlFromEnv,
  type DatabaseEnvironment,
} from './database-config.js';
import {
  EventFingerprintConflictError,
  IdempotencyConflictError,
} from './errors.js';
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
  webhookReceipts,
  workflowRuns,
} from './schema.js';
import { assertValidUsage } from './validation.js';

type Database = NeonHttpDatabase<typeof schema>;

function one<T>(rows: readonly T[], description: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${description} was not returned`);
  return row;
}

function normalized<T>(row: object): T {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null),
  ) as T;
}

function normalizedRows<T>(rows: readonly object[]): readonly T[] {
  return rows.map((row) => normalized<T>(row));
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
    row.recordedAt === usage.recordedAt
  );
}

export class NeonDomainRepository implements DomainRepository {
  public constructor(private readonly database: Database) {}

  async createProject(project: Project): Promise<Project> {
    return normalized(
      one(
        await this.database.insert(projects).values(project).returning(),
        'Project',
      ),
    );
  }

  async getProject(id: ProjectId): Promise<Project | undefined> {
    const row = await this.database.query.projects.findFirst({
      where: eq(projects.id, id),
    });
    return row === undefined ? undefined : normalized(row);
  }

  async listProjects(): Promise<readonly Project[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(projects)
        .orderBy(asc(projects.createdAt)),
    );
  }

  async createConfigRevision(
    revision: ConfigRevision,
  ): Promise<ConfigRevision> {
    return normalized(
      one(
        await this.database
          .insert(configRevisions)
          .values(revision)
          .returning(),
        'Config revision',
      ),
    );
  }

  async getConfigRevision(
    id: ConfigRevisionId,
  ): Promise<ConfigRevision | undefined> {
    const row = await this.database.query.configRevisions.findFirst({
      where: eq(configRevisions.id, id),
    });
    return row === undefined ? undefined : normalized(row);
  }

  async listConfigRevisions(
    projectId: ProjectId,
  ): Promise<readonly ConfigRevision[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(configRevisions)
        .where(eq(configRevisions.projectId, projectId))
        .orderBy(asc(configRevisions.revision)),
    );
  }

  async createConfigSnapshot(
    snapshot: ConfigSnapshot,
  ): Promise<ConfigSnapshot> {
    return normalized(
      one(
        await this.database
          .insert(configSnapshots)
          .values(snapshot)
          .returning(),
        'Config snapshot',
      ),
    );
  }

  async getConfigSnapshot(
    id: ConfigSnapshotId,
  ): Promise<ConfigSnapshot | undefined> {
    const row = await this.database.query.configSnapshots.findFirst({
      where: eq(configSnapshots.id, id),
    });
    return row === undefined ? undefined : normalized(row);
  }

  async listConfigSnapshots(
    runId: WorkflowRunId,
  ): Promise<readonly ConfigSnapshot[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(configSnapshots)
        .where(eq(configSnapshots.runId, runId))
        .orderBy(asc(configSnapshots.createdAt)),
    );
  }

  async createRun(run: WorkflowRun): Promise<WorkflowRun> {
    return normalized(
      one(
        await this.database.insert(workflowRuns).values(run).returning(),
        'Run',
      ),
    );
  }

  async getRun(id: WorkflowRunId): Promise<WorkflowRun | undefined> {
    const row = await this.database.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, id),
    });
    return row === undefined ? undefined : normalized(row);
  }

  async listRuns(filter: RunListFilter = {}): Promise<readonly WorkflowRun[]> {
    return normalizedRows(
      await this.database
        .select()
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
    );
  }

  async updateRun(
    id: WorkflowRunId,
    update: WorkflowRunUpdate,
  ): Promise<WorkflowRun> {
    return normalized(
      one(
        await this.database
          .update(workflowRuns)
          .set(update)
          .where(eq(workflowRuns.id, id))
          .returning(),
        `Run ${id}`,
      ),
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
      .returning();
    return normalized(one(rows, 'Step run'));
  }

  async getStepRun(id: StepRunId): Promise<StepRun | undefined> {
    const row = await this.database.query.stepRuns.findFirst({
      where: eq(stepRuns.id, id),
    });
    return row === undefined ? undefined : normalized(row);
  }

  async listStepRuns(runId: WorkflowRunId): Promise<readonly StepRun[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(stepRuns)
        .where(eq(stepRuns.runId, runId))
        .orderBy(asc(stepRuns.stepKey), asc(stepRuns.attempt)),
    );
  }

  async createExternalSession(
    session: ExternalSession,
  ): Promise<ExternalSession> {
    return normalized(
      one(
        await this.database
          .insert(externalSessions)
          .values(session)
          .returning(),
        'External session',
      ),
    );
  }

  async getExternalSession(
    id: ExternalSessionId,
  ): Promise<ExternalSession | undefined> {
    const row = await this.database.query.externalSessions.findFirst({
      where: eq(externalSessions.id, id),
    });
    return row === undefined ? undefined : normalized(row);
  }

  async listExternalSessions(
    runId: WorkflowRunId,
  ): Promise<readonly ExternalSession[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(externalSessions)
        .where(eq(externalSessions.runId, runId))
        .orderBy(asc(externalSessions.createdAt)),
    );
  }

  async createApproval(approval: Approval): Promise<Approval> {
    return normalized(
      one(
        await this.database.insert(approvals).values(approval).returning(),
        'Approval',
      ),
    );
  }

  async getApproval(id: ApprovalId): Promise<Approval | undefined> {
    const row = await this.database.query.approvals.findFirst({
      where: eq(approvals.id, id),
    });
    return row === undefined ? undefined : normalized(row);
  }

  async listApprovals(runId: WorkflowRunId): Promise<readonly Approval[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(approvals)
        .where(eq(approvals.runId, runId))
        .orderBy(asc(approvals.createdAt)),
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
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : normalized(row);
  }

  async createInboxMessage(message: InboxMessage): Promise<InboxMessage> {
    return normalized(
      one(
        await this.database.insert(inboxMessages).values(message).returning(),
        'Inbox message',
      ),
    );
  }

  async getInboxMessage(id: InboxMessageId): Promise<InboxMessage | undefined> {
    const row = await this.database.query.inboxMessages.findFirst({
      where: eq(inboxMessages.id, id),
    });
    return row === undefined ? undefined : normalized(row);
  }

  async listInboxMessages(
    runId: WorkflowRunId,
    status?: InboxMessage['status'],
  ): Promise<readonly InboxMessage[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.runId, runId),
            status === undefined ? undefined : eq(inboxMessages.status, status),
          ),
        )
        .orderBy(asc(inboxMessages.createdAt)),
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
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(
        `Inbox message ${request.messageId} not found or already replied`,
      );
    }
    return normalized(row);
  }

  async appendEvent(event: DomainEvent): Promise<DomainEvent> {
    const inserted = await this.database
      .insert(domainEvents)
      .values(event)
      .onConflictDoNothing({
        target: [domainEvents.runId, domainEvents.eventId],
      })
      .returning();
    const insertedRow = inserted[0];
    if (insertedRow !== undefined) return normalized(insertedRow);

    const existing = await this.database.query.domainEvents.findFirst({
      where: and(
        eq(domainEvents.runId, event.runId),
        eq(domainEvents.eventId, event.eventId),
      ),
    });
    if (existing === undefined)
      throw new Error('Event conflict could not be resolved');
    if (existing.fingerprint !== event.fingerprint) {
      throw new EventFingerprintConflictError(event.runId, event.eventId);
    }
    return normalized(existing);
  }

  async listEvents(runId: WorkflowRunId): Promise<readonly DomainEvent[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.runId, runId))
        .orderBy(asc(domainEvents.sequence)),
    );
  }

  async createArtifact(artifact: ArtifactRecord): Promise<ArtifactRecord> {
    return normalized(
      one(
        await this.database.insert(artifacts).values(artifact).returning(),
        'Artifact',
      ),
    );
  }

  async getArtifact(id: ArtifactId): Promise<ArtifactRecord | undefined> {
    const row = await this.database.query.artifacts.findFirst({
      where: eq(artifacts.id, id),
    });
    return row === undefined ? undefined : normalized(row);
  }

  async listArtifacts(
    runId: WorkflowRunId,
  ): Promise<readonly ArtifactRecord[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(artifacts)
        .where(eq(artifacts.runId, runId))
        .orderBy(asc(artifacts.createdAt)),
    );
  }

  async appendUsage(usage: UsageRecordEntry): Promise<UsageRecordEntry> {
    assertValidUsage(usage);
    const inserted = await this.database
      .insert(usageRecords)
      .values(usage)
      .onConflictDoNothing({ target: usageRecords.idempotencyId })
      .returning();
    const insertedRow = inserted[0];
    if (insertedRow !== undefined) return normalized(insertedRow);

    const existing = await this.database.query.usageRecords.findFirst({
      where: eq(usageRecords.idempotencyId, usage.idempotencyId),
    });
    if (existing === undefined)
      throw new Error('Usage conflict could not be resolved');
    const normalizedExisting = normalized<UsageRecordEntry>(existing);
    if (!usageMatches(normalizedExisting, usage)) {
      throw new IdempotencyConflictError('Usage record', usage.idempotencyId);
    }
    return normalizedExisting;
  }

  async listUsage(runId: WorkflowRunId): Promise<readonly UsageRecordEntry[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.runId, runId))
        .orderBy(asc(usageRecords.recordedAt)),
    );
  }

  async claimWebhook(receipt: WebhookReceipt): Promise<WebhookClaim> {
    const inserted = await this.database
      .insert(webhookReceipts)
      .values(receipt)
      .onConflictDoNothing({
        target: [webhookReceipts.source, webhookReceipts.deliveryId],
      })
      .returning();
    const insertedRow = inserted[0];
    if (insertedRow !== undefined) {
      return { claimed: true, receipt: normalized(insertedRow) };
    }

    const existing = await this.database.query.webhookReceipts.findFirst({
      where: and(
        eq(webhookReceipts.source, receipt.source),
        eq(webhookReceipts.deliveryId, receipt.deliveryId),
      ),
    });
    if (existing === undefined)
      throw new Error('Webhook conflict could not be resolved');
    if (existing.fingerprint !== receipt.fingerprint) {
      throw new IdempotencyConflictError('Webhook receipt', receipt.deliveryId);
    }
    return { claimed: false, receipt: normalized(existing) };
  }

  async createGoalCriterion(criterion: GoalCriterion): Promise<GoalCriterion> {
    return normalized(
      one(
        await this.database.insert(goalCriteria).values(criterion).returning(),
        'Goal criterion',
      ),
    );
  }

  async listGoalCriteria(
    runId: WorkflowRunId,
  ): Promise<readonly GoalCriterion[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(goalCriteria)
        .where(eq(goalCriteria.runId, runId))
        .orderBy(asc(goalCriteria.ordinal)),
    );
  }

  async appendGoalProgress(progress: GoalProgress): Promise<GoalProgress> {
    return normalized(
      one(
        await this.database.insert(goalProgress).values(progress).returning(),
        'Goal progress',
      ),
    );
  }

  async listGoalProgress(
    runId: WorkflowRunId,
  ): Promise<readonly GoalProgress[]> {
    return normalizedRows(
      await this.database
        .select()
        .from(goalProgress)
        .where(eq(goalProgress.runId, runId))
        .orderBy(asc(goalProgress.recordedAt)),
    );
  }
}

export function createNeonDomainRepository(
  databaseUrl: string,
): DomainRepository {
  const validatedUrl = databaseUrlFromEnv({ DATABASE_URL: databaseUrl });
  const client = neon(validatedUrl);
  return new NeonDomainRepository(drizzle(client, { schema }));
}

export function createNeonDomainRepositoryFromEnv(
  environment: DatabaseEnvironment,
): DomainRepository {
  return createNeonDomainRepository(databaseUrlFromEnv(environment));
}
