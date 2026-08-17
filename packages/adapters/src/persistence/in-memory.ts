import {
  canonicalJsonValue,
  isoTimestamp,
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
  ExternalSession,
  ExternalSessionId,
  ExternalSessionListFilter,
  GoalCriterion,
  GoalProgress,
  GoalProgressId,
  InboxMessage,
  InboxMessageId,
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

import {
  EventFingerprintConflictError,
  IdempotencyConflictError,
  StaleConfigurationError,
} from './errors.js';
import { boundedListLimit } from './pagination.js';
import {
  assertValidArtifact,
  assertValidConfigRevision,
  assertValidEvent,
  assertValidGoalCriterion,
  assertValidStepRun,
  assertValidUsage,
} from './validation.js';

export {
  EventFingerprintConflictError,
  EventSequenceConflictError,
  IdempotencyConflictError,
  StaleConfigurationError,
} from './errors.js';

function copy<T>(value: T): T {
  return structuredClone(value);
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
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

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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

function compareTimestamped(
  leftAt: string,
  leftId: string,
  rightAt: string,
  rightId: string,
): number {
  const instantOrder =
    isoTimestampEpochMicroseconds(isoTimestamp(leftAt)) -
    isoTimestampEpochMicroseconds(isoTimestamp(rightAt));
  return instantOrder === 0n
    ? compareOpaqueText(leftId, rightId)
    : instantOrder < 0n
      ? -1
      : 1;
}

const textEncoder = new TextEncoder();

function compareOpaqueText(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function isAfterTimestamp(
  at: string,
  id: string,
  cursor: TimestampListCursor<string> | undefined,
): boolean {
  return (
    cursor === undefined || compareTimestamped(at, id, cursor.at, cursor.id) > 0
  );
}

export class InMemoryDomainRepository implements DomainRepository {
  readonly #projects = new Map<string, Project>();
  readonly #configRevisions = new Map<string, ConfigRevision>();
  readonly #configRevisionKeys = new Map<string, string>();
  readonly #configSnapshots = new Map<string, ConfigSnapshot>();
  #runs = new Map<string, WorkflowRun>();
  readonly #runIdempotencyFingerprints = new Map<string, string>();
  readonly #stepRuns = new Map<string, StepRun>();
  readonly #stepKeys = new Map<string, string>();
  readonly #externalSessions = new Map<string, ExternalSession>();
  readonly #externalSessionKeys = new Map<string, string>();
  #approvals = new Map<string, Approval>();
  #inboxMessages = new Map<string, InboxMessage>();
  #events = new Map<string, DomainEvent>();
  #nextEventSequence = new Map<string, number>();
  readonly #artifacts = new Map<string, ArtifactRecord>();
  readonly #artifactKeys = new Map<string, string>();
  readonly #usage = new Map<string, UsageRecordEntry>();
  readonly #webhooks = new Map<string, WebhookReceipt>();
  readonly #goalCriteria = new Map<string, GoalCriterion>();
  readonly #goalCriterionKeys = new Map<string, string>();
  readonly #goalProgress = new Map<string, GoalProgress>();

  constructor(
    private readonly failBeforeCommit: (operation: string) => void = () => {},
  ) {}

  async createProject(project: Project): Promise<Project> {
    return insertUnique(this.#projects, project.id, project, 'Project');
  }

  async getProject(id: ProjectId): Promise<Project | undefined> {
    const value = this.#projects.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listProjects(
    page: ListPage<TimestampListCursor<ProjectId>> = {},
  ): Promise<readonly Project[]> {
    return copy(
      [...this.#projects.values()]
        .filter((project) =>
          isAfterTimestamp(project.createdAt, project.id, page.after),
        )
        .sort((left, right) =>
          compareTimestamped(
            left.createdAt,
            left.id,
            right.createdAt,
            right.id,
          ),
        )
        .slice(0, boundedListLimit(page.limit)),
    );
  }

  async createConfigRevision(
    revision: ConfigRevision,
  ): Promise<ConfigRevision> {
    requireEntry(this.#projects, revision.projectId, 'Project');
    assertValidConfigRevision(revision);
    const key = `${revision.projectId}\u0000${revision.revision}`;
    if (this.#configRevisionKeys.has(key)) {
      throw new Error(
        `Config revision ${revision.revision} for project ${revision.projectId} already exists`,
      );
    }
    const created = insertUnique(
      this.#configRevisions,
      revision.id,
      revision,
      'Config revision',
    );
    this.#configRevisionKeys.set(key, revision.id);
    return created;
  }

  async applyConfigRevision(
    project: Project,
    revision: ConfigRevisionDraft,
    precondition?: ConfigRevisionPrecondition,
  ): Promise<ConfigRevision> {
    const existing = this.#configRevisions.get(revision.id);
    if (existing !== undefined) {
      if (!configRevisionMatches(existing, revision)) {
        throw new IdempotencyConflictError('Config revision', revision.id);
      }
      return copy(existing);
    }
    const active = [...this.#configRevisions.values()].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.revision - left.revision ||
        right.id.localeCompare(left.id),
    )[0];
    if (
      precondition !== undefined &&
      (active?.revision ?? null) !== precondition.revision
    ) {
      throw new StaleConfigurationError();
    }
    if (
      precondition !== undefined &&
      (active?.configDigest ?? null) !== precondition.digest
    ) {
      throw new StaleConfigurationError();
    }
    const existingProject = this.#projects.get(project.id);
    const storedProject: Project =
      existingProject === undefined
        ? project
        : {
            id: existingProject.id,
            name: project.name,
            ...(project.repository === undefined
              ? {}
              : { repository: project.repository }),
            createdAt: existingProject.createdAt,
            updatedAt: project.updatedAt,
          };
    const nextRevision =
      Math.max(
        0,
        ...[...this.#configRevisions.values()]
          .filter((entry) => entry.projectId === project.id)
          .map((entry) => entry.revision),
      ) + 1;
    const created = { ...revision, revision: nextRevision };
    assertValidConfigRevision(created);
    const key = `${project.id}\u0000${String(nextRevision)}`;
    this.failBeforeCommit('applyConfigRevision');
    this.#projects.set(project.id, copy(storedProject));
    this.#configRevisions.set(created.id, copy(created));
    this.#configRevisionKeys.set(key, created.id);
    return copy(created);
  }

  async getConfigRevision(
    id: ConfigRevisionId,
  ): Promise<ConfigRevision | undefined> {
    const value = this.#configRevisions.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async getLatestConfigRevision(): Promise<ConfigRevision | undefined> {
    const latest = [...this.#configRevisions.values()].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.revision - left.revision ||
        right.id.localeCompare(left.id),
    )[0];
    return latest === undefined ? undefined : copy(latest);
  }

  async listConfigRevisions(
    projectId: ProjectId,
    page: ListPage<number> = {},
  ): Promise<readonly ConfigRevision[]> {
    return copy(
      [...this.#configRevisions.values()]
        .filter(
          (revision) =>
            revision.projectId === projectId &&
            (page.after === undefined || revision.revision > page.after),
        )
        .sort((left, right) => left.revision - right.revision)
        .slice(0, boundedListLimit(page.limit)),
    );
  }

  async createConfigSnapshot(
    snapshot: ConfigSnapshot,
  ): Promise<ConfigSnapshot> {
    requireEntry(this.#runs, snapshot.runId, 'Run');
    requireEntry(
      this.#configRevisions,
      snapshot.configRevisionId,
      'Config revision',
    );
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
    page: ListPage<TimestampListCursor<ConfigSnapshotId>> = {},
  ): Promise<readonly ConfigSnapshot[]> {
    return copy(
      [...this.#configSnapshots.values()]
        .filter(
          (snapshot) =>
            snapshot.runId === runId &&
            isAfterTimestamp(snapshot.createdAt, snapshot.id, page.after),
        )
        .sort((left, right) =>
          compareTimestamped(
            left.createdAt,
            left.id,
            right.createdAt,
            right.id,
          ),
        )
        .slice(0, boundedListLimit(page.limit)),
    );
  }

  async createRun(run: WorkflowRun): Promise<WorkflowRun> {
    requireEntry(this.#projects, run.projectId, 'Project');
    if (run.configRevisionId !== undefined) {
      requireEntry(
        this.#configRevisions,
        run.configRevisionId,
        'Config revision',
      );
    }
    return insertUnique(this.#runs, run.id, run, 'Run');
  }

  async createRunIdempotently(
    run: WorkflowRun,
    idempotencyFingerprint: string,
  ): Promise<WorkflowRun> {
    const existing = this.#runs.get(run.id);
    if (existing !== undefined) {
      if (
        this.#runIdempotencyFingerprints.get(run.id) !== idempotencyFingerprint
      ) {
        throw new IdempotencyConflictError('Run', run.id);
      }
      return copy(existing);
    }
    requireEntry(this.#projects, run.projectId, 'Project');
    if (run.configRevisionId !== undefined) {
      requireEntry(
        this.#configRevisions,
        run.configRevisionId,
        'Config revision',
      );
    }
    const created = insertUnique(this.#runs, run.id, run, 'Run');
    this.#runIdempotencyFingerprints.set(run.id, idempotencyFingerprint);
    return created;
  }

  async getRun(id: WorkflowRunId): Promise<WorkflowRun | undefined> {
    const value = this.#runs.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listRuns(filter: RunListFilter = {}): Promise<readonly WorkflowRun[]> {
    return copy(
      [...this.#runs.values()]
        .filter(
          (run) =>
            (filter.projectId === undefined ||
              run.projectId === filter.projectId) &&
            (filter.status === undefined || run.status === filter.status) &&
            isAfterTimestamp(run.createdAt, run.id, filter.after),
        )
        .sort((left, right) =>
          compareTimestamped(
            left.createdAt,
            left.id,
            right.createdAt,
            right.id,
          ),
        )
        .slice(0, boundedListLimit(filter.limit)),
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
    requireEntry(this.#runs, step.runId, 'Run');
    assertValidStepRun(step);
    if (step.externalSessionId !== undefined) {
      requireEntry(
        this.#externalSessions,
        step.externalSessionId,
        'External session',
      );
    }
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

  async listStepRuns(
    runId: WorkflowRunId,
    page: ListPage<StepRunListCursor> = {},
  ): Promise<readonly StepRun[]> {
    return copy(
      [...this.#stepRuns.values()]
        .filter(
          (step) =>
            step.runId === runId &&
            (page.after === undefined ||
              compareOpaqueText(step.stepKey, page.after.stepKey) > 0 ||
              (step.stepKey === page.after.stepKey &&
                step.attempt > page.after.attempt)),
        )
        .sort((left, right) =>
          left.stepKey === right.stepKey
            ? left.attempt - right.attempt
            : compareOpaqueText(left.stepKey, right.stepKey),
        )
        .slice(0, boundedListLimit(page.limit)),
    );
  }

  async createExternalSession(
    session: ExternalSession,
  ): Promise<ExternalSession> {
    requireEntry(this.#runs, session.runId, 'Run');
    if (session.stepRunId !== undefined) {
      requireEntry(this.#stepRuns, session.stepRunId, 'Step run');
    }
    const key = `${session.provider}\u0000${session.externalId}`;
    if (this.#externalSessionKeys.has(key)) {
      throw new Error(
        `External session ${session.provider}/${session.externalId} already exists`,
      );
    }
    const created = insertUnique(
      this.#externalSessions,
      session.id,
      session,
      'External session',
    );
    this.#externalSessionKeys.set(key, session.id);
    return created;
  }

  async getExternalSession(
    id: ExternalSessionId,
  ): Promise<ExternalSession | undefined> {
    const value = this.#externalSessions.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listExternalSessions(
    runId: WorkflowRunId,
    filter: ExternalSessionListFilter = {},
  ): Promise<readonly ExternalSession[]> {
    return copy(
      [...this.#externalSessions.values()]
        .filter(
          (session) =>
            session.runId === runId &&
            (filter.provider === undefined ||
              session.provider === filter.provider) &&
            isAfterTimestamp(session.createdAt, session.id, filter.after),
        )
        .sort((left, right) =>
          compareTimestamped(
            left.createdAt,
            left.id,
            right.createdAt,
            right.id,
          ),
        )
        .slice(0, boundedListLimit(filter.limit)),
    );
  }

  async createApproval(approval: Approval): Promise<Approval> {
    requireEntry(this.#runs, approval.runId, 'Run');
    return insertUnique(this.#approvals, approval.id, approval, 'Approval');
  }

  async getApproval(id: ApprovalId): Promise<Approval | undefined> {
    const value = this.#approvals.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listApprovals(
    runId: WorkflowRunId,
    filter: ApprovalListFilter = {},
  ): Promise<readonly Approval[]> {
    return copy(
      [...this.#approvals.values()]
        .filter(
          (approval) =>
            approval.runId === runId &&
            (filter.status === undefined ||
              approval.status === filter.status) &&
            isAfterTimestamp(approval.createdAt, approval.id, filter.after),
        )
        .sort((left, right) =>
          compareTimestamped(
            left.createdAt,
            left.id,
            right.createdAt,
            right.id,
          ),
        )
        .slice(0, boundedListLimit(filter.limit)),
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
    requireEntry(this.#runs, message.runId, 'Run');
    if (message.stepRunId !== undefined) {
      requireEntry(this.#stepRuns, message.stepRunId, 'Step run');
    }
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
    page: ListPage<TimestampListCursor<InboxMessageId>> = {},
  ): Promise<readonly InboxMessage[]> {
    return copy(
      [...this.#inboxMessages.values()]
        .filter(
          (message) =>
            message.runId === runId &&
            (status === undefined || message.status === status) &&
            isAfterTimestamp(message.createdAt, message.id, page.after),
        )
        .sort((left, right) =>
          compareTimestamped(
            left.createdAt,
            left.id,
            right.createdAt,
            right.id,
          ),
        )
        .slice(0, boundedListLimit(page.limit)),
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

  #stageEvent(event: DomainEventDraft): {
    readonly key: string;
    readonly event: DomainEvent;
    readonly replay: boolean;
  } {
    assertPersistenceTimestamps(event);
    requireEntry(this.#runs, event.runId, 'Run');
    const key = `${event.runId}\u0000${event.eventId}`;
    const existing = this.#events.get(key);
    if (existing !== undefined) {
      if (
        existing.fingerprint !== event.fingerprint ||
        existing.type !== event.type ||
        !same(existing.payload, event.payload)
      ) {
        throw new EventFingerprintConflictError(event.runId, event.eventId);
      }
      return { key, event: copy(existing), replay: true };
    }
    const sequence = this.#nextEventSequence.get(event.runId) ?? 1;
    const staged: DomainEvent = { ...copy(event), sequence };
    assertValidEvent(staged);
    return { key, event: staged, replay: false };
  }

  #applyStagedEvent(
    staged: {
      readonly key: string;
      readonly event: DomainEvent;
      readonly replay: boolean;
    },
    events: Map<string, DomainEvent>,
    sequences: Map<string, number>,
  ): void {
    if (staged.replay) return;
    events.set(staged.key, copy(staged.event));
    sequences.set(staged.event.runId, staged.event.sequence + 1);
  }

  #commitStagedEvent(staged: {
    readonly key: string;
    readonly event: DomainEvent;
    readonly replay: boolean;
  }): void {
    if (staged.replay) return;
    const events = new Map(this.#events);
    const sequences = new Map(this.#nextEventSequence);
    this.#applyStagedEvent(staged, events, sequences);
    this.#events = events;
    this.#nextEventSequence = sequences;
  }

  async appendEvent(event: DomainEventDraft): Promise<DomainEvent> {
    const staged = this.#stageEvent(event);
    if (!staged.replay) {
      this.failBeforeCommit('appendEvent');
      this.#commitStagedEvent(staged);
    }
    return copy(staged.event);
  }

  async getEvent(
    runId: WorkflowRunId,
    eventId: import('@agentos/core').EventId,
  ): Promise<DomainEvent | undefined> {
    const value = this.#events.get(`${runId}\u0000${eventId}`);
    return value === undefined ? undefined : copy(value);
  }

  async cancelRunWithEvent(
    runId: WorkflowRunId,
    update: WorkflowRunUpdate,
    event: DomainEventDraft,
  ): Promise<WorkflowRun> {
    if (event.runId !== runId)
      throw new Error('event run does not match mutation');
    const run = requireEntry(this.#runs, runId, 'Run');
    const staged = this.#stageEvent(event);
    if (staged.replay) {
      if (run.status !== 'cancelled')
        throw new Error('event replay does not match run state');
      return copy(run);
    }
    assertPersistenceTimestamps(update);
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      throw new Error(`Run ${runId} cannot be cancelled`);
    }
    const cancelled: WorkflowRun = {
      ...run,
      ...copy(update),
      status: 'cancelled',
    };
    const runs = new Map(this.#runs);
    const events = new Map(this.#events);
    const sequences = new Map(this.#nextEventSequence);
    runs.set(runId, cancelled);
    this.#applyStagedEvent(staged, events, sequences);
    this.failBeforeCommit('cancelRunWithEvent');
    this.#runs = runs;
    this.#events = events;
    this.#nextEventSequence = sequences;
    return copy(cancelled);
  }

  async consumeApprovalWithEvent(
    request: ConsumeApprovalRequest,
    event: DomainEventDraft,
  ): Promise<Approval | undefined> {
    if (event.runId !== request.runId)
      throw new Error('event run does not match mutation');
    assertPersistenceTimestamps(request);
    const approval = this.#approvals.get(request.approvalId);
    const staged = this.#stageEvent(event);
    if (staged.replay) {
      if (approval?.status !== 'consumed')
        throw new Error('event replay does not match approval state');
      return copy(approval);
    }
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
    const approvals = new Map(this.#approvals);
    const events = new Map(this.#events);
    const sequences = new Map(this.#nextEventSequence);
    approvals.set(approval.id, copy(consumed));
    this.#applyStagedEvent(staged, events, sequences);
    this.failBeforeCommit('consumeApprovalWithEvent');
    this.#approvals = approvals;
    this.#events = events;
    this.#nextEventSequence = sequences;
    return copy(consumed);
  }

  async replyInboxMessageWithEvent(
    request: ReplyInboxMessageRequest,
    event: DomainEventDraft,
  ): Promise<InboxMessage> {
    assertPersistenceTimestamps(request);
    const message = requireEntry(
      this.#inboxMessages,
      request.messageId,
      'Inbox message',
    );
    if (event.runId !== message.runId)
      throw new Error('event run does not match mutation');
    const staged = this.#stageEvent(event);
    if (staged.replay) {
      if (message.status !== 'replied' || !same(message.reply, request.reply))
        throw new Error('event replay does not match inbox state');
      return copy(message);
    }
    if (message.status !== 'pending') {
      throw new Error(`Inbox message ${request.messageId} already replied`);
    }
    const replied: InboxMessage = {
      ...message,
      status: 'replied',
      reply: copy(request.reply),
      repliedAt: request.repliedAt,
    };
    const inboxMessages = new Map(this.#inboxMessages);
    const events = new Map(this.#events);
    const sequences = new Map(this.#nextEventSequence);
    inboxMessages.set(message.id, copy(replied));
    this.#applyStagedEvent(staged, events, sequences);
    this.failBeforeCommit('replyInboxMessageWithEvent');
    this.#inboxMessages = inboxMessages;
    this.#events = events;
    this.#nextEventSequence = sequences;
    return copy(replied);
  }

  async listEvents(
    runId: WorkflowRunId,
    page: ListPage<number> = {},
  ): Promise<readonly DomainEvent[]> {
    return copy(
      [...this.#events.values()]
        .filter(
          (event) =>
            event.runId === runId &&
            (page.after === undefined || event.sequence > page.after),
        )
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, boundedListLimit(page.limit)),
    );
  }

  async createArtifact(artifact: ArtifactRecord): Promise<ArtifactRecord> {
    requireEntry(this.#runs, artifact.runId, 'Run');
    if (artifact.stepRunId !== undefined) {
      requireEntry(this.#stepRuns, artifact.stepRunId, 'Step run');
    }
    assertValidArtifact(artifact);
    const key = `${artifact.runId}\u0000${artifact.key}`;
    if (this.#artifactKeys.has(key)) {
      throw new Error(
        `Artifact key ${artifact.key} for run ${artifact.runId} already exists`,
      );
    }
    const created = insertUnique(
      this.#artifacts,
      artifact.id,
      artifact,
      'Artifact',
    );
    this.#artifactKeys.set(key, artifact.id);
    return created;
  }

  async getArtifact(id: ArtifactId): Promise<ArtifactRecord | undefined> {
    const value = this.#artifacts.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listArtifacts(
    runId: WorkflowRunId,
    page: ListPage<TimestampListCursor<ArtifactId>> = {},
  ): Promise<readonly ArtifactRecord[]> {
    return copy(
      [...this.#artifacts.values()]
        .filter(
          (artifact) =>
            artifact.runId === runId &&
            isAfterTimestamp(artifact.createdAt, artifact.id, page.after),
        )
        .sort((left, right) =>
          compareTimestamped(
            left.createdAt,
            left.id,
            right.createdAt,
            right.id,
          ),
        )
        .slice(0, boundedListLimit(page.limit)),
    );
  }

  async appendUsage(usage: UsageRecordEntry): Promise<UsageRecordEntry> {
    assertPersistenceTimestamps(usage);
    assertValidUsage(usage);
    requireEntry(this.#runs, usage.runId, 'Run');
    if (usage.stepRunId !== undefined) {
      requireEntry(this.#stepRuns, usage.stepRunId, 'Step run');
    }
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

  async listUsage(
    runId: WorkflowRunId,
    page: ListPage<TimestampListCursor<UsageId>> = {},
  ): Promise<readonly UsageRecordEntry[]> {
    return copy(
      [...this.#usage.values()]
        .filter(
          (usage) =>
            usage.runId === runId &&
            isAfterTimestamp(usage.recordedAt, usage.idempotencyId, page.after),
        )
        .sort((left, right) =>
          compareTimestamped(
            left.recordedAt,
            left.idempotencyId,
            right.recordedAt,
            right.idempotencyId,
          ),
        )
        .slice(0, boundedListLimit(page.limit)),
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
    requireEntry(this.#runs, criterion.runId, 'Run');
    assertValidGoalCriterion(criterion);
    const key = `${criterion.runId}\u0000${criterion.ordinal}`;
    if (this.#goalCriterionKeys.has(key)) {
      throw new Error(
        `Goal criterion ordinal ${criterion.ordinal} for run ${criterion.runId} already exists`,
      );
    }
    const created = insertUnique(
      this.#goalCriteria,
      criterion.id,
      criterion,
      'Goal criterion',
    );
    this.#goalCriterionKeys.set(key, criterion.id);
    return created;
  }

  async listGoalCriteria(
    runId: WorkflowRunId,
    page: ListPage<number> = {},
  ): Promise<readonly GoalCriterion[]> {
    return copy(
      [...this.#goalCriteria.values()]
        .filter(
          (criterion) =>
            criterion.runId === runId &&
            (page.after === undefined || criterion.ordinal > page.after),
        )
        .sort((left, right) => left.ordinal - right.ordinal)
        .slice(0, boundedListLimit(page.limit)),
    );
  }

  async appendGoalProgress(progress: GoalProgress): Promise<GoalProgress> {
    requireEntry(this.#runs, progress.runId, 'Run');
    if (progress.criterionId !== undefined) {
      requireEntry(this.#goalCriteria, progress.criterionId, 'Goal criterion');
    }
    return insertUnique(
      this.#goalProgress,
      progress.id,
      progress,
      'Goal progress',
    );
  }

  async listGoalProgress(
    runId: WorkflowRunId,
    page: ListPage<TimestampListCursor<GoalProgressId>> = {},
  ): Promise<readonly GoalProgress[]> {
    return copy(
      [...this.#goalProgress.values()]
        .filter(
          (progress) =>
            progress.runId === runId &&
            isAfterTimestamp(progress.recordedAt, progress.id, page.after),
        )
        .sort((left, right) =>
          compareTimestamped(
            left.recordedAt,
            left.id,
            right.recordedAt,
            right.id,
          ),
        )
        .slice(0, boundedListLimit(page.limit)),
    );
  }
}
