import { isoTimestamp, isoTimestampEpochMicroseconds } from '@agentos/core';
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

import {
  EventFingerprintConflictError,
  EventSequenceConflictError,
  IdempotencyConflictError,
} from './errors.js';
import { assertValidUsage } from './validation.js';

export {
  EventFingerprintConflictError,
  EventSequenceConflictError,
  IdempotencyConflictError,
} from './errors.js';

function copy<T>(value: T): T {
  return structuredClone(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPersistenceTimestamps(value: object): void {
  for (const [key, entry] of Object.entries(value)) {
    if (key.endsWith('At') && entry !== undefined) {
      if (typeof entry !== 'string') {
        throw new TypeError('timestamp must be an ISO 8601 string');
      }
      isoTimestamp(entry);
    }
  }
}

function requireEntry<T>(map: Map<string, T>, id: string, kind: string): T {
  const value = map.get(id);
  if (value === undefined) throw new Error(`${kind} ${id} not found`);
  return value;
}

function insertUnique<T>(
  map: Map<string, T>,
  id: string,
  value: T,
  kind: string,
): T {
  if (typeof value === 'object' && value !== null) {
    assertPersistenceTimestamps(value);
  }
  if (map.has(id)) throw new Error(`${kind} ${id} already exists`);
  const stored = copy(value);
  map.set(id, stored);
  return copy(stored);
}

export class InMemoryDomainRepository implements DomainRepository {
  readonly #projects = new Map<string, Project>();
  readonly #configRevisions = new Map<string, ConfigRevision>();
  readonly #configSnapshots = new Map<string, ConfigSnapshot>();
  readonly #runs = new Map<string, WorkflowRun>();
  readonly #stepRuns = new Map<string, StepRun>();
  readonly #stepKeys = new Map<string, string>();
  readonly #externalSessions = new Map<string, ExternalSession>();
  readonly #approvals = new Map<string, Approval>();
  readonly #inboxMessages = new Map<string, InboxMessage>();
  readonly #events = new Map<string, DomainEvent>();
  readonly #eventSequences = new Map<string, string>();
  readonly #artifacts = new Map<string, ArtifactRecord>();
  readonly #usage = new Map<string, UsageRecordEntry>();
  readonly #webhooks = new Map<string, WebhookReceipt>();
  readonly #goalCriteria = new Map<string, GoalCriterion>();
  readonly #goalProgress = new Map<string, GoalProgress>();

  async createProject(project: Project): Promise<Project> {
    return insertUnique(this.#projects, project.id, project, 'Project');
  }

  async getProject(id: ProjectId): Promise<Project | undefined> {
    const value = this.#projects.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listProjects(): Promise<readonly Project[]> {
    return copy([...this.#projects.values()]);
  }

  async createConfigRevision(
    revision: ConfigRevision,
  ): Promise<ConfigRevision> {
    return insertUnique(
      this.#configRevisions,
      revision.id,
      revision,
      'Config revision',
    );
  }

  async getConfigRevision(
    id: ConfigRevisionId,
  ): Promise<ConfigRevision | undefined> {
    const value = this.#configRevisions.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listConfigRevisions(
    projectId: ProjectId,
  ): Promise<readonly ConfigRevision[]> {
    return copy(
      [...this.#configRevisions.values()]
        .filter((revision) => revision.projectId === projectId)
        .sort((left, right) => left.revision - right.revision),
    );
  }

  async createConfigSnapshot(
    snapshot: ConfigSnapshot,
  ): Promise<ConfigSnapshot> {
    return insertUnique(
      this.#configSnapshots,
      snapshot.id,
      snapshot,
      'Config snapshot',
    );
  }

  async getConfigSnapshot(
    id: ConfigSnapshotId,
  ): Promise<ConfigSnapshot | undefined> {
    const value = this.#configSnapshots.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listConfigSnapshots(
    runId: WorkflowRunId,
  ): Promise<readonly ConfigSnapshot[]> {
    return copy(
      [...this.#configSnapshots.values()].filter(
        (snapshot) => snapshot.runId === runId,
      ),
    );
  }

  async createRun(run: WorkflowRun): Promise<WorkflowRun> {
    return insertUnique(this.#runs, run.id, run, 'Run');
  }

  async getRun(id: WorkflowRunId): Promise<WorkflowRun | undefined> {
    const value = this.#runs.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listRuns(filter: RunListFilter = {}): Promise<readonly WorkflowRun[]> {
    return copy(
      [...this.#runs.values()].filter(
        (run) =>
          (filter.projectId === undefined ||
            run.projectId === filter.projectId) &&
          (filter.status === undefined || run.status === filter.status),
      ),
    );
  }

  async updateRun(
    id: WorkflowRunId,
    update: WorkflowRunUpdate,
  ): Promise<WorkflowRun> {
    assertPersistenceTimestamps(update);
    const current = requireEntry(this.#runs, id, 'Run');
    const updated = copy({ ...current, ...update });
    this.#runs.set(id, updated);
    return copy(updated);
  }

  async upsertStepRun(step: StepRun): Promise<StepRun> {
    assertPersistenceTimestamps(step);
    const key = `${step.runId}\u0000${step.stepKey}\u0000${step.attempt}`;
    const existingId = this.#stepKeys.get(key);
    if (existingId === undefined) {
      insertUnique(this.#stepRuns, step.id, step, 'Step run');
      this.#stepKeys.set(key, step.id);
      return copy(step);
    }
    const existing = requireEntry(this.#stepRuns, existingId, 'Step run');
    const updated = copy({
      ...existing,
      ...step,
      id: existing.id,
      createdAt: existing.createdAt,
    });
    this.#stepRuns.set(existing.id, updated);
    return copy(updated);
  }

  async getStepRun(id: StepRunId): Promise<StepRun | undefined> {
    const value = this.#stepRuns.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listStepRuns(runId: WorkflowRunId): Promise<readonly StepRun[]> {
    return copy(
      [...this.#stepRuns.values()]
        .filter((step) => step.runId === runId)
        .sort((left, right) =>
          left.stepKey === right.stepKey
            ? left.attempt - right.attempt
            : left.stepKey.localeCompare(right.stepKey),
        ),
    );
  }

  async createExternalSession(
    session: ExternalSession,
  ): Promise<ExternalSession> {
    return insertUnique(
      this.#externalSessions,
      session.id,
      session,
      'External session',
    );
  }

  async getExternalSession(
    id: ExternalSessionId,
  ): Promise<ExternalSession | undefined> {
    const value = this.#externalSessions.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listExternalSessions(
    runId: WorkflowRunId,
  ): Promise<readonly ExternalSession[]> {
    return copy(
      [...this.#externalSessions.values()].filter(
        (session) => session.runId === runId,
      ),
    );
  }

  async createApproval(approval: Approval): Promise<Approval> {
    return insertUnique(this.#approvals, approval.id, approval, 'Approval');
  }

  async getApproval(id: ApprovalId): Promise<Approval | undefined> {
    const value = this.#approvals.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listApprovals(runId: WorkflowRunId): Promise<readonly Approval[]> {
    return copy(
      [...this.#approvals.values()].filter(
        (approval) => approval.runId === runId,
      ),
    );
  }

  async consumeApproval(
    request: ConsumeApprovalRequest,
  ): Promise<Approval | undefined> {
    assertPersistenceTimestamps(request);
    const approval = this.#approvals.get(request.approvalId);
    if (
      approval === undefined ||
      approval.runId !== request.runId ||
      approval.scope !== request.scope ||
      approval.fingerprint !== request.fingerprint ||
      approval.status !== 'pending' ||
      isoTimestampEpochMicroseconds(approval.expiresAt) <=
        isoTimestampEpochMicroseconds(request.consumedAt)
    ) {
      return undefined;
    }
    const consumed: Approval = {
      ...approval,
      status: 'consumed',
      consumedAt: request.consumedAt,
    };
    this.#approvals.set(approval.id, consumed);
    return copy(consumed);
  }

  async createInboxMessage(message: InboxMessage): Promise<InboxMessage> {
    return insertUnique(
      this.#inboxMessages,
      message.id,
      message,
      'Inbox message',
    );
  }

  async getInboxMessage(id: InboxMessageId): Promise<InboxMessage | undefined> {
    const value = this.#inboxMessages.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listInboxMessages(
    runId: WorkflowRunId,
    status?: InboxMessage['status'],
  ): Promise<readonly InboxMessage[]> {
    return copy(
      [...this.#inboxMessages.values()].filter(
        (message) =>
          message.runId === runId &&
          (status === undefined || message.status === status),
      ),
    );
  }

  async replyInboxMessage(
    request: ReplyInboxMessageRequest,
  ): Promise<InboxMessage> {
    assertPersistenceTimestamps(request);
    const message = requireEntry(
      this.#inboxMessages,
      request.messageId,
      'Inbox message',
    );
    if (message.status !== 'pending') {
      throw new Error(`Inbox message ${request.messageId} already replied`);
    }
    const replied: InboxMessage = {
      ...message,
      status: 'replied',
      reply: copy(request.reply),
      repliedAt: request.repliedAt,
    };
    this.#inboxMessages.set(message.id, replied);
    return copy(replied);
  }

  async appendEvent(event: DomainEvent): Promise<DomainEvent> {
    assertPersistenceTimestamps(event);
    const key = `${event.runId}\u0000${event.eventId}`;
    const existing = this.#events.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== event.fingerprint) {
        throw new EventFingerprintConflictError(event.runId, event.eventId);
      }
      return copy(existing);
    }
    const sequenceKey = `${event.runId}\u0000${event.sequence}`;
    if (this.#eventSequences.has(sequenceKey)) {
      throw new EventSequenceConflictError(event.runId, event.sequence);
    }
    const stored = copy(event);
    this.#events.set(key, stored);
    this.#eventSequences.set(sequenceKey, key);
    return copy(stored);
  }

  async listEvents(runId: WorkflowRunId): Promise<readonly DomainEvent[]> {
    return copy(
      [...this.#events.values()]
        .filter((event) => event.runId === runId)
        .sort((left, right) => left.sequence - right.sequence),
    );
  }

  async createArtifact(artifact: ArtifactRecord): Promise<ArtifactRecord> {
    return insertUnique(this.#artifacts, artifact.id, artifact, 'Artifact');
  }

  async getArtifact(id: ArtifactId): Promise<ArtifactRecord | undefined> {
    const value = this.#artifacts.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listArtifacts(
    runId: WorkflowRunId,
  ): Promise<readonly ArtifactRecord[]> {
    return copy(
      [...this.#artifacts.values()].filter(
        (artifact) => artifact.runId === runId,
      ),
    );
  }

  async appendUsage(usage: UsageRecordEntry): Promise<UsageRecordEntry> {
    assertPersistenceTimestamps(usage);
    assertValidUsage(usage);
    const existing = this.#usage.get(usage.idempotencyId);
    if (existing !== undefined) {
      if (!same(existing, usage)) {
        throw new IdempotencyConflictError('Usage record', usage.idempotencyId);
      }
      return copy(existing);
    }
    const stored = copy(usage);
    this.#usage.set(usage.idempotencyId, stored);
    return copy(stored);
  }

  async listUsage(runId: WorkflowRunId): Promise<readonly UsageRecordEntry[]> {
    return copy(
      [...this.#usage.values()].filter((usage) => usage.runId === runId),
    );
  }

  async claimWebhook(receipt: WebhookReceipt): Promise<WebhookClaim> {
    assertPersistenceTimestamps(receipt);
    const key = `${receipt.source}\u0000${receipt.deliveryId}`;
    const existing = this.#webhooks.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== receipt.fingerprint) {
        throw new IdempotencyConflictError(
          'Webhook receipt',
          receipt.deliveryId,
        );
      }
      return { claimed: false, receipt: copy(existing) };
    }
    const stored = copy(receipt);
    this.#webhooks.set(key, stored);
    return { claimed: true, receipt: copy(stored) };
  }

  async createGoalCriterion(criterion: GoalCriterion): Promise<GoalCriterion> {
    return insertUnique(
      this.#goalCriteria,
      criterion.id,
      criterion,
      'Goal criterion',
    );
  }

  async listGoalCriteria(
    runId: WorkflowRunId,
  ): Promise<readonly GoalCriterion[]> {
    return copy(
      [...this.#goalCriteria.values()]
        .filter((criterion) => criterion.runId === runId)
        .sort((left, right) => left.ordinal - right.ordinal),
    );
  }

  async appendGoalProgress(progress: GoalProgress): Promise<GoalProgress> {
    return insertUnique(
      this.#goalProgress,
      progress.id,
      progress,
      'Goal progress',
    );
  }

  async listGoalProgress(
    runId: WorkflowRunId,
  ): Promise<readonly GoalProgress[]> {
    return copy(
      [...this.#goalProgress.values()]
        .filter((progress) => progress.runId === runId)
        .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)),
    );
  }
}
