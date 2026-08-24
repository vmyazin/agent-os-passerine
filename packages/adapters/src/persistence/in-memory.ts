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
  Backlog,
  BacklogId,
  BacklogItem,
  BacklogItemId,
  BacklogItemStatus,
  BacklogStatus,
  ApprovalListFilter,
  ArtifactCapabilityQuotaRequest,
  ArtifactCapabilityQuotaResult,
  ArtifactCleanupLeaseRequest,
  ArtifactDeletionFinalizationRequest,
  ArtifactDeletionReservationRequest,
  ArtifactId,
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
  assertValidGoalProgress,
  assertValidStepRun,
  assertValidUsage,
  sameGoalCriterion,
  sameGoalProgress,
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

function immutableArtifactMatches(
  existing: ArtifactRecord,
  requested: ArtifactRecord,
): boolean {
  return (
    existing.id === requested.id &&
    existing.runId === requested.runId &&
    existing.key === requested.key &&
    existing.uri === requested.uri &&
    existing.digest === requested.digest &&
    existing.mediaType === requested.mediaType &&
    existing.sizeBytes === requested.sizeBytes &&
    existing.retentionClass === requested.retentionClass &&
    existing.createdAt === requested.createdAt &&
    existing.cleanupAt === requested.cleanupAt &&
    existing.manifestVersion === requested.manifestVersion
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
  readonly #artifactCapabilityQuotas = new Map<
    string,
    {
      fingerprint: string;
      notBefore: string;
      expiresAt: string;
      calls: number;
      cumulativeBytes: number;
    }
  >();
  #artifactCleanupLease:
    | { owner: string; expiresAt: import('@agentos/core').IsoTimestamp }
    | undefined;
  readonly #usage = new Map<string, UsageRecordEntry>();
  readonly #webhooks = new Map<string, WebhookReceipt>();
  readonly #goalCriteria = new Map<string, GoalCriterion>();
  readonly #goalCriterionKeys = new Map<string, string>();
  readonly #backlogs = new Map<string, Backlog>();
  readonly #backlogItems = new Map<string, BacklogItem>();
  readonly #backlogItemOrdinals = new Map<string, string>();
  readonly #backlogItemRuns = new Map<string, string>();
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
    const active = [...this.#configRevisions.values()]
      .filter((entry) => entry.projectId === project.id)
      .sort(
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

  async getLatestConfigRevision(
    projectId: ProjectId,
  ): Promise<ConfigRevision | undefined> {
    const latest = [...this.#configRevisions.values()]
      .filter((revision) => revision.projectId === projectId)
      .sort(
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
    return insertUnique(
      this.#runs,
      run.id,
      { ...run, stateVersion: run.stateVersion ?? 0 },
      'Run',
    );
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
    const created = insertUnique(
      this.#runs,
      run.id,
      { ...run, stateVersion: run.stateVersion ?? 0 },
      'Run',
    );
    this.#runIdempotencyFingerprints.set(run.id, idempotencyFingerprint);
    return created;
  }

  async getRun(id: WorkflowRunId): Promise<WorkflowRun | undefined> {
    const value = this.#runs.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listRuns(filter: RunListFilter = {}): Promise<readonly WorkflowRun[]> {
    if (filter.order === 'desc' && filter.after !== undefined)
      throw new TypeError('descending run listing does not support cursors');
    return copy(
      [...this.#runs.values()]
        .filter(
          (run) =>
            (filter.projectId === undefined ||
              run.projectId === filter.projectId) &&
            (filter.status === undefined || run.status === filter.status) &&
            isAfterTimestamp(run.createdAt, run.id, filter.after),
        )
        .sort((left, right) => {
          const ordered = compareTimestamped(
            left.createdAt,
            left.id,
            right.createdAt,
            right.id,
          );
          return filter.order === 'desc' ? -ordered : ordered;
        })
        .slice(0, boundedListLimit(filter.limit)),
    );
  }

  async countRuns(
    filter: Pick<RunListFilter, 'projectId' | 'status'> = {},
  ): Promise<number> {
    return [...this.#runs.values()].filter(
      (run) =>
        (filter.projectId === undefined || run.projectId === filter.projectId) &&
        (filter.status === undefined || run.status === filter.status),
    ).length;
  }

  async updateRun(
    id: WorkflowRunId,
    update: WorkflowRunUpdate,
  ): Promise<WorkflowRun> {
    assertPersistenceTimestamps(update);
    const current = requireEntry(this.#runs, id, 'Run');
    const updated = copy({
      ...current,
      ...update,
      stateVersion: (current.stateVersion ?? 0) + 1,
    });
    this.#runs.set(id, updated);
    return copy(updated);
  }

  async transitionRun(
    id: WorkflowRunId,
    expectedStatuses: readonly RunStatus[],
    update: WorkflowRunUpdate,
    expectedVersion?: number,
  ): Promise<WorkflowRun | undefined> {
    assertPersistenceTimestamps(update);
    const current = requireEntry(this.#runs, id, 'Run');
    if (
      !expectedStatuses.includes(current.status) ||
      (expectedVersion !== undefined &&
        (current.stateVersion ?? 0) !== expectedVersion)
    )
      return undefined;
    const updated = copy({
      ...current,
      ...update,
      stateVersion: (current.stateVersion ?? 0) + 1,
    });
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

  async updateExternalSession(
    id: ExternalSessionId,
    update: ExternalSessionUpdate,
  ): Promise<ExternalSession> {
    const current = requireEntry(
      this.#externalSessions,
      id,
      'External session',
    );
    const updated = copy({ ...current, ...update });
    this.#externalSessions.set(id, updated);
    return copy(updated);
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

  async expireApproval(
    id: ApprovalId,
    binding: {
      readonly runId: WorkflowRunId;
      readonly scope: string;
      readonly fingerprint: string;
      readonly at: IsoTimestamp;
    },
  ): Promise<Approval | undefined> {
    const approval = this.#approvals.get(id);
    if (
      approval === undefined ||
      approval.status !== 'pending' ||
      approval.runId !== binding.runId ||
      approval.scope !== binding.scope ||
      approval.fingerprint !== binding.fingerprint ||
      approval.expiresAt > binding.at
    )
      return undefined;
    const expired = { ...approval, status: 'expired' as const };
    this.#approvals.set(id, expired);
    return copy(expired);
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

  async claimArtifact(artifact: ArtifactRecord): Promise<ArtifactRecord> {
    requireEntry(this.#runs, artifact.runId, 'Run');
    assertValidArtifact(artifact);
    const key = `${artifact.runId}\u0000${artifact.key}`;
    const existingId = this.#artifactKeys.get(key);
    if (existingId !== undefined) return copy(this.#artifacts.get(existingId)!);
    const created = insertUnique(
      this.#artifacts,
      artifact.id,
      artifact,
      'Artifact',
    );
    this.#artifactKeys.set(key, artifact.id);
    return created;
  }

  async claimArtifactForWrite(
    request: ArtifactWriteClaimRequest,
  ): Promise<ArtifactRecord> {
    const { artifact } = request;
    requireEntry(this.#runs, artifact.runId, 'Run');
    assertValidArtifact(artifact);
    if (
      request.leaseId.trim() === '' ||
      isoTimestampEpochMicroseconds(request.expiresAt) <=
        isoTimestampEpochMicroseconds(request.now)
    )
      throw new TypeError('artifact write lease is invalid');
    const key = `${artifact.runId}\u0000${artifact.key}`;
    const existingId = this.#artifactKeys.get(key);
    if (existingId === undefined) {
      const created = insertUnique(
        this.#artifacts,
        artifact.id,
        {
          ...artifact,
          deletionState: 'active',
          writeLeaseId: request.leaseId,
          writeLeaseExpiresAt: request.expiresAt,
        },
        'Artifact',
      );
      this.#artifactKeys.set(key, artifact.id);
      return created;
    }
    const existing = this.#artifacts.get(existingId)!;
    if (
      !immutableArtifactMatches(existing, artifact) ||
      existing.deletionState !== 'active' ||
      (existing.writeLeaseId !== undefined &&
        existing.writeLeaseId !== request.leaseId &&
        existing.writeLeaseExpiresAt !== undefined &&
        isoTimestampEpochMicroseconds(existing.writeLeaseExpiresAt) >
          isoTimestampEpochMicroseconds(request.now))
    )
      return copy(existing);
    const updated = {
      ...existing,
      writeLeaseId: request.leaseId,
      writeLeaseExpiresAt: request.expiresAt,
    };
    this.#artifacts.set(existing.id, copy(updated));
    return copy(updated);
  }

  async releaseArtifactWriteLease(
    id: ArtifactId,
    leaseId: string,
  ): Promise<void> {
    const existing = requireEntry(this.#artifacts, id, 'Artifact');
    if (existing.writeLeaseId !== leaseId) return;
    const updated = { ...existing };
    delete updated.writeLeaseId;
    delete updated.writeLeaseExpiresAt;
    this.#artifacts.set(id, copy(updated));
  }

  async getArtifact(id: ArtifactId): Promise<ArtifactRecord | undefined> {
    const value = this.#artifacts.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async getArtifactByRunKey(
    runId: WorkflowRunId,
    key: string,
  ): Promise<ArtifactRecord | undefined> {
    const id = this.#artifactKeys.get(`${runId}\u0000${key}`);
    const value = id === undefined ? undefined : this.#artifacts.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async listArtifactsByRunKey(
    runId: WorkflowRunId,
    keyPrefix: string,
    afterKey: string | undefined,
    limit: number,
  ): Promise<readonly ArtifactRecord[]> {
    return copy(
      [...this.#artifacts.values()]
        .filter(
          (artifact) =>
            artifact.runId === runId &&
            artifact.deletedAt === undefined &&
            artifact.manifestVersion === 'artifact-manifest-v1' &&
            artifact.deletionState === 'active' &&
            artifact.key.startsWith(keyPrefix) &&
            (afterKey === undefined ||
              compareOpaqueText(artifact.key, afterKey) > 0),
        )
        .sort((left, right) => compareOpaqueText(left.key, right.key))
        .slice(0, limit),
    );
  }

  async listArtifactsDueForCleanup(
    before: import('@agentos/core').IsoTimestamp,
    limit: number,
  ): Promise<readonly ArtifactRecord[]> {
    const cutoff = isoTimestampEpochMicroseconds(before);
    return copy(
      [...this.#artifacts.values()]
        .filter(
          (artifact) =>
            artifact.manifestVersion === 'artifact-manifest-v1' &&
            artifact.deletedAt === undefined &&
            (artifact.deletionState === 'active' ||
              artifact.deletionState === 'pending') &&
            artifact.cleanupAt !== undefined &&
            isoTimestampEpochMicroseconds(artifact.cleanupAt) <= cutoff,
        )
        .sort((left, right) =>
          compareTimestamped(
            left.cleanupAt!,
            left.id,
            right.cleanupAt!,
            right.id,
          ),
        )
        .slice(0, limit),
    );
  }

  async reserveArtifactDeletion(
    request: ArtifactDeletionReservationRequest,
  ): Promise<ArtifactRecord | undefined> {
    const existing = this.#artifacts.get(request.id);
    if (
      existing === undefined ||
      existing.runId !== request.runId ||
      existing.key !== request.logicalKey ||
      existing.uri !== request.uri ||
      existing.digest !== request.digest ||
      existing.manifestVersion !== 'artifact-manifest-v1' ||
      existing.deletionState === 'deleted' ||
      existing.deletedAt !== undefined ||
      (existing.writeLeaseId !== undefined &&
        existing.writeLeaseExpiresAt !== undefined &&
        isoTimestampEpochMicroseconds(existing.writeLeaseExpiresAt) >
          isoTimestampEpochMicroseconds(request.now))
    )
      return undefined;
    if (existing.deletionState === 'pending') return copy(existing);
    if (existing.deletionState !== 'active') return undefined;
    const updated = {
      ...existing,
      deletionState: 'pending' as const,
      deletionRequestedAt: request.requestedAt,
      deletionReason: request.reason,
    };
    this.#artifacts.set(existing.id, copy(updated));
    return copy(updated);
  }

  async finalizeArtifactDeletion(
    request: ArtifactDeletionFinalizationRequest,
  ): Promise<ArtifactRecord> {
    const existing = requireEntry(this.#artifacts, request.id, 'Artifact');
    if (
      existing.runId !== request.runId ||
      existing.key !== request.logicalKey ||
      existing.uri !== request.uri ||
      existing.digest !== request.digest ||
      existing.manifestVersion !== 'artifact-manifest-v1'
    )
      throw new Error('Artifact deletion identity does not match');
    if (existing.deletionState === 'deleted') return copy(existing);
    if (existing.deletionState !== 'pending')
      throw new Error('Artifact deletion was not reserved');
    const updated = {
      ...existing,
      deletionState: 'deleted' as const,
      deletedAt: request.deletedAt,
      deletionReason: existing.deletionReason ?? request.reason,
    };
    this.#artifacts.set(existing.id, copy(updated));
    return copy(updated);
  }

  async consumeArtifactCapabilityQuota(
    request: ArtifactCapabilityQuotaRequest,
  ): Promise<ArtifactCapabilityQuotaResult> {
    validateArtifactQuotaRequest(request);
    const key = `${request.purpose}\u0000${request.audience}\u0000${request.nonce}`;
    const existing = this.#artifactCapabilityQuotas.get(key);
    const active =
      isoTimestampEpochMicroseconds(request.now) >=
        isoTimestampEpochMicroseconds(request.notBefore) &&
      isoTimestampEpochMicroseconds(request.now) <
        isoTimestampEpochMicroseconds(request.expiresAt);
    if (!active)
      return { allowed: false, replayed: false, calls: 0, cumulativeBytes: 0 };
    if (existing === undefined) {
      if (request.maxCalls < 1 || request.bytes > request.maxCumulativeBytes)
        return {
          allowed: false,
          replayed: false,
          calls: 0,
          cumulativeBytes: 0,
        };
      this.#artifactCapabilityQuotas.set(key, {
        fingerprint: request.fingerprint,
        notBefore: request.notBefore,
        expiresAt: request.expiresAt,
        calls: 1,
        cumulativeBytes: request.bytes,
      });
      return {
        allowed: true,
        replayed: false,
        calls: 1,
        cumulativeBytes: request.bytes,
      };
    }
    if (
      existing.fingerprint !== request.fingerprint ||
      existing.notBefore !== request.notBefore ||
      existing.expiresAt !== request.expiresAt
    )
      return {
        allowed: false,
        replayed: false,
        calls: existing.calls,
        cumulativeBytes: existing.cumulativeBytes,
      };
    if (
      existing.calls >= request.maxCalls ||
      existing.cumulativeBytes + request.bytes > request.maxCumulativeBytes
    )
      return {
        allowed: false,
        replayed: false,
        calls: existing.calls,
        cumulativeBytes: existing.cumulativeBytes,
      };
    existing.calls += 1;
    existing.cumulativeBytes += request.bytes;
    return {
      allowed: true,
      replayed: false,
      calls: existing.calls,
      cumulativeBytes: existing.cumulativeBytes,
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
    if (
      this.#artifactCleanupLease !== undefined &&
      isoTimestampEpochMicroseconds(this.#artifactCleanupLease.expiresAt) >
        isoTimestampEpochMicroseconds(request.now)
    )
      return false;
    this.#artifactCleanupLease = {
      owner: request.owner,
      expiresAt: request.expiresAt,
    };
    return true;
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
    if (
      this.#artifactCleanupLease?.owner !== request.owner ||
      isoTimestampEpochMicroseconds(this.#artifactCleanupLease.expiresAt) <=
        isoTimestampEpochMicroseconds(request.now)
    )
      return false;
    this.#artifactCleanupLease = {
      owner: request.owner,
      expiresAt: request.expiresAt,
    };
    return true;
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

  async createGoalCriterionIdempotently(
    criterion: GoalCriterion,
  ): Promise<GoalCriterion> {
    requireEntry(this.#runs, criterion.runId, 'Run');
    assertValidGoalCriterion(criterion);
    const existing = this.#goalCriteria.get(criterion.id);
    if (existing !== undefined) {
      if (!sameGoalCriterion(existing, criterion))
        throw new IdempotencyConflictError('Goal criterion', criterion.id);
      return copy(existing);
    }
    const ordinalKey = `${criterion.runId}\u0000${criterion.ordinal}`;
    if (this.#goalCriterionKeys.has(ordinalKey))
      throw new IdempotencyConflictError(
        'Goal criterion ordinal',
        `${criterion.runId}:${String(criterion.ordinal)}`,
      );
    return this.createGoalCriterion(criterion);
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
    assertValidGoalProgress(progress);
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

  async appendGoalProgressIdempotently(
    progress: GoalProgress,
  ): Promise<GoalProgress> {
    requireEntry(this.#runs, progress.runId, 'Run');
    assertValidGoalProgress(progress);
    if (progress.criterionId !== undefined)
      requireEntry(this.#goalCriteria, progress.criterionId, 'Goal criterion');
    const existing = this.#goalProgress.get(progress.id);
    if (existing !== undefined) {
      if (!sameGoalProgress(existing, progress))
        throw new IdempotencyConflictError('Goal progress', progress.id);
      return copy(existing);
    }
    return this.appendGoalProgress(progress);
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

  async createBacklog(backlog: Backlog): Promise<Backlog> {
    requireEntry(this.#projects, backlog.projectId, 'Project');
    return insertUnique(this.#backlogs, backlog.id, backlog, 'Backlog');
  }

  async getBacklog(id: BacklogId): Promise<Backlog | undefined> {
    const found = this.#backlogs.get(id);
    return found === undefined ? undefined : copy(found);
  }

  async listBacklogs(
    projectId: ProjectId,
    page: ListPage<TimestampListCursor<BacklogId>> = {},
  ): Promise<readonly Backlog[]> {
    return copy(
      [...this.#backlogs.values()]
        .filter(
          (backlog) =>
            backlog.projectId === projectId &&
            isAfterTimestamp(backlog.createdAt, backlog.id, page.after),
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

  async updateBacklogStatus(request: {
    readonly id: BacklogId;
    readonly expected: readonly BacklogStatus[];
    readonly status: BacklogStatus;
    readonly pausedReason?: string;
    readonly updatedAt: IsoTimestamp;
  }): Promise<Backlog | undefined> {
    const existing = this.#backlogs.get(request.id);
    if (existing === undefined || !request.expected.includes(existing.status))
      return undefined;
    const updated: Backlog = {
      ...existing,
      status: request.status,
      // A backlog that is no longer paused carries no stale reason.
      ...(request.status === 'paused' && request.pausedReason !== undefined
        ? { pausedReason: request.pausedReason }
        : {}),
      updatedAt: request.updatedAt,
    };
    if (request.status !== 'paused') delete (updated as { pausedReason?: string }).pausedReason;
    this.#backlogs.set(request.id, copy(updated));
    return copy(updated);
  }

  async createBacklogItemIdempotently(
    item: BacklogItem,
  ): Promise<BacklogItem> {
    requireEntry(this.#backlogs, item.backlogId, 'Backlog');
    const existing = this.#backlogItems.get(item.id);
    if (existing !== undefined) {
      if (
        existing.backlogId !== item.backlogId ||
        existing.ordinal !== item.ordinal ||
        existing.title !== item.title ||
        existing.description !== item.description
      )
        throw new IdempotencyConflictError('Backlog item', item.id);
      return copy(existing);
    }
    const ordinalKey = `${item.backlogId}\u0000${String(item.ordinal)}`;
    if (this.#backlogItemOrdinals.has(ordinalKey))
      throw new IdempotencyConflictError(
        'Backlog item ordinal',
        `${item.backlogId}:${String(item.ordinal)}`,
      );
    const created = insertUnique(
      this.#backlogItems,
      item.id,
      item,
      'Backlog item',
    );
    this.#backlogItemOrdinals.set(ordinalKey, item.id);
    if (item.runId !== undefined) this.#backlogItemRuns.set(item.runId, item.id);
    return created;
  }

  async listBacklogItems(
    backlogId: BacklogId,
    page: ListPage<number> = {},
  ): Promise<readonly BacklogItem[]> {
    return copy(
      [...this.#backlogItems.values()]
        .filter(
          (item) =>
            item.backlogId === backlogId &&
            (page.after === undefined || item.ordinal > page.after),
        )
        .sort((left, right) => left.ordinal - right.ordinal)
        .slice(0, boundedListLimit(page.limit)),
    );
  }

  async deleteBacklog(id: BacklogId): Promise<boolean> {
    if (!this.#backlogs.has(id)) return false;
    const items = [...this.#backlogItems.values()].filter(
      (item) => item.backlogId === id,
    );
    if (items.some((item) => item.runId !== undefined)) return false;
    for (const item of items) {
      this.#backlogItems.delete(item.id);
      this.#backlogItemOrdinals.delete(
        `${item.backlogId}\u0000${String(item.ordinal)}`,
      );
    }
    this.#backlogs.delete(id);
    return true;
  }

  async updateBacklogItem(request: {
    readonly id: BacklogItemId;
    readonly expected: readonly BacklogItemStatus[];
    readonly status: BacklogItemStatus;
    readonly runId?: string;
    readonly updatedAt: IsoTimestamp;
  }): Promise<BacklogItem | undefined> {
    const existing = this.#backlogItems.get(request.id);
    if (existing === undefined || !request.expected.includes(existing.status))
      return undefined;
    if (request.runId !== undefined) {
      // One run per item, deployment-wide: the unique index in Postgres, and
      // this map here, are what make a racing dispatch produce one run.
      const owner = this.#backlogItemRuns.get(request.runId);
      if (owner !== undefined && owner !== request.id) return undefined;
      if (existing.runId !== undefined && existing.runId !== request.runId)
        return undefined;
    }
    const updated: BacklogItem = {
      ...existing,
      status: request.status,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      updatedAt: request.updatedAt,
    };
    this.#backlogItems.set(request.id, copy(updated));
    if (updated.runId !== undefined)
      this.#backlogItemRuns.set(updated.runId, updated.id);
    return copy(updated);
  }
}
