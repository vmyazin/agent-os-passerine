declare const persistenceIdBrand: unique symbol;
declare const isoTimestampBrand: unique symbol;

export type PersistenceIdKind =
  | 'project'
  | 'configRevision'
  | 'configSnapshot'
  | 'run'
  | 'stepRun'
  | 'externalSession'
  | 'approval'
  | 'inboxMessage'
  | 'event'
  | 'artifact'
  | 'usage'
  | 'webhookDelivery'
  | 'goalCriterion'
  | 'goalProgress';

export type PersistenceId<Kind extends PersistenceIdKind> = string & {
  readonly [persistenceIdBrand]: Kind;
};
export type ProjectId = PersistenceId<'project'>;
export type ConfigRevisionId = PersistenceId<'configRevision'>;
export type ConfigSnapshotId = PersistenceId<'configSnapshot'>;
export type WorkflowRunId = PersistenceId<'run'>;
export type StepRunId = PersistenceId<'stepRun'>;
export type ExternalSessionId = PersistenceId<'externalSession'>;
export type ApprovalId = PersistenceId<'approval'>;
export type InboxMessageId = PersistenceId<'inboxMessage'>;
export type EventId = PersistenceId<'event'>;
export type ArtifactId = PersistenceId<'artifact'>;
export type UsageId = PersistenceId<'usage'>;
export type WebhookDeliveryId = PersistenceId<'webhookDelivery'>;
export type GoalCriterionId = PersistenceId<'goalCriterion'>;
export type GoalProgressId = PersistenceId<'goalProgress'>;

export type IsoTimestamp = string & {
  readonly [isoTimestampBrand]: 'IsoTimestamp';
};

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
const ISO_TIMESTAMP_INSTANT =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

function hasValidCalendarParts(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === 'Z' ? 0 : Number(match[9]);
  const offsetMinute = match[7] === 'Z' ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0)
  );
}

export function persistenceId<Kind extends PersistenceIdKind>(
  kind: Kind,
  value: string,
): PersistenceId<Kind> {
  if (value.trim() === '')
    throw new TypeError(`${kind} identifier must not be empty`);
  return value as PersistenceId<Kind>;
}

export function isoTimestamp(value: string): IsoTimestamp {
  const match = ISO_TIMESTAMP.exec(value);
  if (
    match === null ||
    !hasValidCalendarParts(match) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError('timestamp must be an ISO 8601 string');
  }
  return value as IsoTimestamp;
}

export function isoTimestampEpochMicroseconds(value: IsoTimestamp): bigint {
  const match = ISO_TIMESTAMP_INSTANT.exec(value);
  if (match === null)
    throw new TypeError('timestamp must be an ISO 8601 string');

  const utcMilliseconds = Date.parse(`${match[1]}T${match[2]}Z`);
  const offsetMinutes =
    match[4] === 'Z'
      ? 0
      : (match[5] === '+' ? 1 : -1) *
        (Number(match[6]) * 60 + Number(match[7]));
  const fractionMicroseconds = BigInt((match[3] ?? '').padEnd(6, '0') || '0');

  return (
    BigInt(utcMilliseconds - offsetMinutes * 60_000) * 1_000n +
    fractionMicroseconds
  );
}
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type RunStatus =
  'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type StepRunStatus =
  'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly repository?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface PersistenceDigests {
  readonly configDigest: string;
  readonly modelDigest: string;
  readonly promptDigest: string;
  readonly environmentDigest: string;
  readonly policyDigest: string;
  readonly repositorySha: string;
}

export interface ConfigRevision extends PersistenceDigests {
  readonly id: ConfigRevisionId;
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly config: JsonValue;
  readonly createdAt: IsoTimestamp;
}

export type ConfigRevisionDraft = Omit<ConfigRevision, 'revision'>;

export interface ConfigRevisionPrecondition {
  readonly revision: number | null;
  readonly digest: string | null;
}

export interface ConfigSnapshot extends PersistenceDigests {
  readonly id: ConfigSnapshotId;
  readonly runId: WorkflowRunId;
  readonly configRevisionId: ConfigRevisionId;
  readonly config: JsonValue;
  readonly createdAt: IsoTimestamp;
}

export interface WorkflowRun {
  readonly id: WorkflowRunId;
  readonly projectId: ProjectId;
  readonly configRevisionId?: ConfigRevisionId;
  readonly pipeline: string;
  readonly status: RunStatus;
  readonly input?: JsonValue;
  readonly output?: JsonValue;
  readonly error?: JsonValue;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly cleanupAt?: IsoTimestamp;
}

export interface WorkflowRunUpdate {
  readonly status?: RunStatus;
  readonly output?: JsonValue;
  readonly error?: JsonValue;
  readonly updatedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly cleanupAt?: IsoTimestamp;
}

export interface RunListFilter {
  readonly projectId?: ProjectId;
  readonly status?: RunStatus;
  readonly limit?: number;
  readonly after?: TimestampListCursor<WorkflowRunId>;
}

export interface TimestampListCursor<Id extends string> {
  readonly at: IsoTimestamp;
  readonly id: Id;
}

export interface ListPage<Cursor> {
  readonly limit?: number;
  readonly after?: Cursor;
}

export interface StepRunListCursor {
  readonly stepKey: string;
  readonly attempt: number;
}

export interface ExternalSessionListFilter extends ListPage<
  TimestampListCursor<ExternalSessionId>
> {
  readonly provider?: string;
}

export interface ApprovalListFilter extends ListPage<
  TimestampListCursor<ApprovalId>
> {
  readonly status?: Approval['status'];
}

export interface StepRun {
  readonly id: StepRunId;
  readonly runId: WorkflowRunId;
  readonly stepKey: string;
  readonly attempt: number;
  readonly status: StepRunStatus;
  readonly input?: JsonValue;
  readonly output?: JsonValue;
  readonly error?: JsonValue;
  readonly externalSessionId?: ExternalSessionId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly cleanupAt?: IsoTimestamp;
}

export interface ExternalSession {
  readonly id: ExternalSessionId;
  readonly runId: WorkflowRunId;
  readonly stepRunId?: StepRunId;
  readonly provider: string;
  readonly externalId: string;
  readonly status: 'active' | 'completed' | 'cancelled' | 'failed';
  readonly state?: JsonValue;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
  readonly cleanupAt?: IsoTimestamp;
}

export interface Approval {
  readonly id: ApprovalId;
  readonly runId: WorkflowRunId;
  readonly scope: string;
  readonly fingerprint: string;
  readonly status: 'pending' | 'consumed' | 'expired';
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly consumedAt?: IsoTimestamp;
}

export interface ConsumeApprovalRequest {
  readonly approvalId: ApprovalId;
  readonly runId: WorkflowRunId;
  readonly scope: string;
  readonly fingerprint: string;
  readonly consumedAt: IsoTimestamp;
}

export interface InboxMessage {
  readonly id: InboxMessageId;
  readonly runId: WorkflowRunId;
  readonly stepRunId?: StepRunId;
  readonly status: 'pending' | 'replied';
  readonly body: JsonValue;
  readonly reply?: JsonValue;
  readonly createdAt: IsoTimestamp;
  readonly repliedAt?: IsoTimestamp;
}

export interface ReplyInboxMessageRequest {
  readonly messageId: InboxMessageId;
  readonly reply: JsonValue;
  readonly repliedAt: IsoTimestamp;
}

export interface DomainEvent {
  readonly runId: WorkflowRunId;
  readonly eventId: EventId;
  readonly fingerprint: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload?: JsonValue;
  readonly occurredAt: IsoTimestamp;
}

/** An event before the repository atomically allocates its per-run sequence. */
export type DomainEventDraft = Omit<DomainEvent, 'sequence'>;

export interface ArtifactRecord {
  readonly id: ArtifactId;
  readonly runId: WorkflowRunId;
  readonly stepRunId?: StepRunId;
  readonly key: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly digest: string;
  readonly uri?: string;
  readonly retentionClass?:
    'source-bundle' | 'cloud-session-upload' | 'working';
  readonly createdAt: IsoTimestamp;
  readonly cleanupAt?: IsoTimestamp;
  readonly deletedAt?: IsoTimestamp;
  readonly deletionReason?: string;
  readonly deletionState?: 'active' | 'pending' | 'deleted';
  readonly deletionRequestedAt?: IsoTimestamp;
  readonly writeLeaseId?: string;
  readonly writeLeaseExpiresAt?: IsoTimestamp;
  readonly manifestVersion?: 'artifact-manifest-v1';
}

export interface ArtifactWriteClaimRequest {
  readonly artifact: ArtifactRecord;
  readonly leaseId: string;
  readonly now: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface ArtifactDeletionReservationRequest {
  readonly id: ArtifactId;
  readonly runId: WorkflowRunId;
  readonly logicalKey: string;
  readonly uri: string;
  readonly digest: string;
  readonly now: IsoTimestamp;
  readonly requestedAt: IsoTimestamp;
  readonly reason: string;
}

export interface ArtifactDeletionFinalizationRequest {
  readonly id: ArtifactId;
  readonly runId: WorkflowRunId;
  readonly logicalKey: string;
  readonly uri: string;
  readonly digest: string;
  readonly deletedAt: IsoTimestamp;
  readonly reason: string;
}

/** Atomic, durable admission request for one capability-scoped MCP operation. */
export interface ArtifactCapabilityQuotaRequest {
  readonly purpose: string;
  readonly audience: string;
  readonly nonce: string;
  readonly fingerprint: string;
  readonly operationId: string;
  readonly bytes: number;
  readonly maxCalls: number;
  readonly maxCumulativeBytes: number;
  readonly notBefore: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly now: IsoTimestamp;
}

export interface ArtifactCapabilityQuotaResult {
  readonly allowed: boolean;
  readonly replayed: boolean;
  readonly calls: number;
  readonly cumulativeBytes: number;
}

export interface ArtifactCleanupLeaseRequest {
  readonly owner: string;
  readonly now: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface UsageRecordEntry {
  readonly idempotencyId: UsageId;
  readonly runId: WorkflowRunId;
  readonly stepRunId?: StepRunId;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runtimeMs: number;
  readonly microdollars: number;
  readonly recordedAt: IsoTimestamp;
}

export interface WebhookReceipt {
  readonly source: string;
  readonly deliveryId: WebhookDeliveryId;
  readonly fingerprint: string;
  readonly receivedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface WebhookClaim {
  readonly claimed: boolean;
  readonly receipt: WebhookReceipt;
}

export interface GoalCriterion {
  readonly id: GoalCriterionId;
  readonly runId: WorkflowRunId;
  readonly ordinal: number;
  readonly description: string;
  readonly status: 'pending' | 'satisfied' | 'failed';
  readonly createdAt: IsoTimestamp;
}

export interface GoalProgress {
  readonly id: GoalProgressId;
  readonly runId: WorkflowRunId;
  readonly criterionId?: GoalCriterionId;
  readonly status: 'pending' | 'satisfied' | 'failed';
  readonly detail?: string;
  readonly payload?: JsonValue;
  readonly recordedAt: IsoTimestamp;
}

export interface DomainRepository {
  createProject(project: Project): Promise<Project>;
  getProject(id: ProjectId): Promise<Project | undefined>;
  listProjects(
    page?: ListPage<TimestampListCursor<ProjectId>>,
  ): Promise<readonly Project[]>;

  createConfigRevision(revision: ConfigRevision): Promise<ConfigRevision>;
  applyConfigRevision(
    project: Project,
    revision: ConfigRevisionDraft,
    precondition?: ConfigRevisionPrecondition,
  ): Promise<ConfigRevision>;
  getConfigRevision(id: ConfigRevisionId): Promise<ConfigRevision | undefined>;
  getLatestConfigRevision(): Promise<ConfigRevision | undefined>;
  listConfigRevisions(
    projectId: ProjectId,
    page?: ListPage<number>,
  ): Promise<readonly ConfigRevision[]>;
  createConfigSnapshot(snapshot: ConfigSnapshot): Promise<ConfigSnapshot>;
  getConfigSnapshot(id: ConfigSnapshotId): Promise<ConfigSnapshot | undefined>;
  listConfigSnapshots(
    runId: WorkflowRunId,
    page?: ListPage<TimestampListCursor<ConfigSnapshotId>>,
  ): Promise<readonly ConfigSnapshot[]>;

  createRun(run: WorkflowRun): Promise<WorkflowRun>;
  createRunIdempotently(
    run: WorkflowRun,
    idempotencyFingerprint: string,
  ): Promise<WorkflowRun>;
  getRun(id: WorkflowRunId): Promise<WorkflowRun | undefined>;
  listRuns(filter?: RunListFilter): Promise<readonly WorkflowRun[]>;
  updateRun(id: WorkflowRunId, update: WorkflowRunUpdate): Promise<WorkflowRun>;

  upsertStepRun(step: StepRun): Promise<StepRun>;
  getStepRun(id: StepRunId): Promise<StepRun | undefined>;
  listStepRuns(
    runId: WorkflowRunId,
    page?: ListPage<StepRunListCursor>,
  ): Promise<readonly StepRun[]>;

  createExternalSession(session: ExternalSession): Promise<ExternalSession>;
  getExternalSession(
    id: ExternalSessionId,
  ): Promise<ExternalSession | undefined>;
  listExternalSessions(
    runId: WorkflowRunId,
    filter?: ExternalSessionListFilter,
  ): Promise<readonly ExternalSession[]>;

  createApproval(approval: Approval): Promise<Approval>;
  getApproval(id: ApprovalId): Promise<Approval | undefined>;
  listApprovals(
    runId: WorkflowRunId,
    filter?: ApprovalListFilter,
  ): Promise<readonly Approval[]>;
  consumeApproval(
    request: ConsumeApprovalRequest,
  ): Promise<Approval | undefined>;

  createInboxMessage(message: InboxMessage): Promise<InboxMessage>;
  getInboxMessage(id: InboxMessageId): Promise<InboxMessage | undefined>;
  listInboxMessages(
    runId: WorkflowRunId,
    status?: InboxMessage['status'],
    page?: ListPage<TimestampListCursor<InboxMessageId>>,
  ): Promise<readonly InboxMessage[]>;
  replyInboxMessage(request: ReplyInboxMessageRequest): Promise<InboxMessage>;

  appendEvent(event: DomainEventDraft): Promise<DomainEvent>;
  getEvent(
    runId: WorkflowRunId,
    eventId: EventId,
  ): Promise<DomainEvent | undefined>;
  cancelRunWithEvent(
    runId: WorkflowRunId,
    update: WorkflowRunUpdate,
    event: DomainEventDraft,
  ): Promise<WorkflowRun>;
  consumeApprovalWithEvent(
    request: ConsumeApprovalRequest,
    event: DomainEventDraft,
  ): Promise<Approval | undefined>;
  replyInboxMessageWithEvent(
    request: ReplyInboxMessageRequest,
    event: DomainEventDraft,
  ): Promise<InboxMessage>;
  listEvents(
    runId: WorkflowRunId,
    page?: ListPage<number>,
  ): Promise<readonly DomainEvent[]>;

  createArtifact(artifact: ArtifactRecord): Promise<ArtifactRecord>;
  claimArtifact(artifact: ArtifactRecord): Promise<ArtifactRecord>;
  claimArtifactForWrite(
    request: ArtifactWriteClaimRequest,
  ): Promise<ArtifactRecord>;
  releaseArtifactWriteLease(id: ArtifactId, leaseId: string): Promise<void>;
  getArtifact(id: ArtifactId): Promise<ArtifactRecord | undefined>;
  getArtifactByRunKey(
    runId: WorkflowRunId,
    key: string,
  ): Promise<ArtifactRecord | undefined>;
  listArtifactsByRunKey(
    runId: WorkflowRunId,
    keyPrefix: string,
    afterKey: string | undefined,
    limit: number,
  ): Promise<readonly ArtifactRecord[]>;
  listArtifactsDueForCleanup(
    before: IsoTimestamp,
    limit: number,
  ): Promise<readonly ArtifactRecord[]>;
  reserveArtifactDeletion(
    request: ArtifactDeletionReservationRequest,
  ): Promise<ArtifactRecord | undefined>;
  finalizeArtifactDeletion(
    request: ArtifactDeletionFinalizationRequest,
  ): Promise<ArtifactRecord>;
  consumeArtifactCapabilityQuota(
    request: ArtifactCapabilityQuotaRequest,
  ): Promise<ArtifactCapabilityQuotaResult>;
  claimArtifactCleanupLease(
    request: ArtifactCleanupLeaseRequest,
  ): Promise<boolean>;
  renewArtifactCleanupLease(
    request: ArtifactCleanupLeaseRequest,
  ): Promise<boolean>;
  listArtifacts(
    runId: WorkflowRunId,
    page?: ListPage<TimestampListCursor<ArtifactId>>,
  ): Promise<readonly ArtifactRecord[]>;

  appendUsage(usage: UsageRecordEntry): Promise<UsageRecordEntry>;
  listUsage(
    runId: WorkflowRunId,
    page?: ListPage<TimestampListCursor<UsageId>>,
  ): Promise<readonly UsageRecordEntry[]>;

  claimWebhook(receipt: WebhookReceipt): Promise<WebhookClaim>;

  createGoalCriterion(criterion: GoalCriterion): Promise<GoalCriterion>;
  listGoalCriteria(
    runId: WorkflowRunId,
    page?: ListPage<number>,
  ): Promise<readonly GoalCriterion[]>;
  appendGoalProgress(progress: GoalProgress): Promise<GoalProgress>;
  listGoalProgress(
    runId: WorkflowRunId,
    page?: ListPage<TimestampListCursor<GoalProgressId>>,
  ): Promise<readonly GoalProgress[]>;
}
