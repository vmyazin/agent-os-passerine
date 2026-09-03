import { createHash } from 'node:crypto';

import {
  BUDGET_OVERRIDE_EVENT,
  RUN_RESUMED_EVENT,
  deterministicGoalCriterionId,
} from '@agentos/adapters';

import type {
  Approval,
  AgentOsConfig,
  CommandCriterion,
  ConfigRevision,
  DomainEvent,
  DomainEventDraft,
  DomainRepository,
  InboxMessage,
  IsoTimestamp,
  JsonValue,
  PersistenceDigests,
  PersistenceId,
  PersistenceIdKind,
  Project,
  RunStatus,
  TimestampListCursor,
  WorkflowRun,
  Backlog,
  BacklogId,
  BacklogItem,
  BacklogItemRun,
  BacklogItemStatus,
  BacklogStatus,
  CommitPage,
  GitHubProjectSource,
  LocalProjectSource,
  ProjectSource,
  ProjectSourceImportInput,
  ProjectSourceImportResult,
  ProjectSourceInspection,
  UserPreferences,
} from '@agentos/core';
import {
  canonicalConfigHash,
  canonicalConfigJson,
  canonicalJsonValue,
  canonicalPublicationPolicyDigest,
  loadAgentOsConfig,
  normalizePublicationPolicySnapshot,
  parseAgentOsConfig,
  persistenceId,
  resolveProjectVerificationPolicy,
  advanceBacklog,
  isValidTimeZone,
  planConfigChange,
} from '@agentos/core';
import { REDACTED_VALUE } from '../ui/redact-configuration';

export type IdGenerator = <Kind extends PersistenceIdKind>(
  kind: Kind,
  idempotencyKey: string,
) => PersistenceId<Kind>;

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface CreateRunInput extends PersistenceDigests {
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  /** A succeeded run in this project whose published commit this run builds on. */
  readonly baseRunId?: string | undefined;
}

/**
 * Where a chained run reads its source, derived by the control plane from
 * the base run's own publication record -- never from caller input.
 */
export interface RunChain {
  readonly baseRunId: string;
  readonly baseBranch: string;
  readonly baseCommitSha: string;
}

export interface CreateGoalRunInput extends CreateRunInput {
  readonly criteria: readonly CommandCriterion[];
}

/**
 * The slice of the workflow checkpoint store a resume needs: enough to clear
 * the checkpoints that refuse a replay, and to see which resume generations a
 * run has already used.
 */
/**
 * The ceiling on a single override. An operator pressing a button to get past
 * a cap should not be able to authorise an unbounded amount by mistyping.
 */
export const MAX_BUDGET_OVERRIDE_MICRODOLLARS = 100_000_000;

export interface RunResumptionStore {
  releaseRunForResume(runId: string): Promise<{ readonly released: number }>;
  listEffects(runId: string): Promise<readonly { readonly key: string }[]>;
}

/** Durable intents live in the run/approval event rows; this port delivers them. */
export interface WorkflowDispatchOutbox {
  requestStart(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
    readonly pipeline: 'feature' | 'goal';
    /** Non-zero when an operator resumed this run, so the dispatch asks for a
     * Trigger key that the finished execution did not already claim. */
    readonly resumeGeneration?: number;
  }): Promise<void>;
  requestApprovalResume(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
    readonly approvalId: string;
    readonly decision: 'approve' | 'reject';
    readonly scopeHash: string;
  }): Promise<void>;
  requestCancel?(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
  }): Promise<void>;
  requestCleanup?(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
  }): Promise<void>;
  requestOrphanReconciliation?(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
  }): Promise<void>;
}

export interface ConfigurationInput {
  readonly canonicalConfig: string;
  readonly digest: string;
  readonly expectedRevision: number | null;
  readonly expectedDigest: string | null;
  /** Optional integrity check; identity always derives from the config. */
  readonly projectId?: string;
}

export interface ProjectSelector {
  readonly projectId?: string;
  readonly repository?: string;
  readonly localPath?: string;
  readonly name?: string;
}

export interface ProjectListProjection {
  readonly id: string;
  readonly name: string;
  readonly binding: string;
  readonly latestRevision?: number;
  readonly configDigest?: string;
  readonly lastRunStatus?: RunStatus;
  readonly lastRunAt?: IsoTimestamp;
  readonly runCount: number;
  readonly updatedAt: IsoTimestamp;
}

export interface ProjectSourceProjection {
  readonly kind: ProjectSource['kind'];
  readonly location: string;
  readonly defaultBranch: string;
  readonly publisherReady?: boolean;
}

export interface ProjectDetailProjection extends ProjectListProjection {
  readonly workflowBudgetMicrodollars?: number;
  readonly dailyBudgetMicrodollars?: number;
  readonly recentRuns: readonly RunProjection[];
  /**
   * The commit a run started now would build on, and the branch head as it
   * currently stands. A run is pinned to the applied revision's SHA, so when
   * these differ the operator is about to build on code they may think they
   * replaced -- worth saying before they press start, not after.
   */
  readonly appliedSha?: string;
  readonly headSha?: string;
  readonly drifted?: boolean;
  readonly source?: ProjectSourceProjection;
}

export type ProjectSourceDraft =
  | Omit<GitHubProjectSource, 'projectId' | 'createdAt' | 'updatedAt'>
  | Omit<LocalProjectSource, 'projectId' | 'createdAt' | 'updatedAt'>;

export interface ProjectSourceGateway {
  inspect(input: ProjectSourceImportInput): Promise<{
    readonly inspection: ProjectSourceInspection;
    readonly source: ProjectSourceDraft;
  }>;
  listCommits(source: ProjectSource, cursor?: string): Promise<CommitPage>;
}

export interface ConfigurationProjection {
  readonly canonicalConfig?: string;
  readonly projectId: string;
  readonly digest: string;
  readonly revision: number;
  readonly appliedAt: IsoTimestamp;
  readonly provenance: PersistenceDigests;
}

export interface UserPreferencesProjection {
  readonly timeZone: string;
  readonly updatedAt: IsoTimestamp;
}

const VALUE_SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b(Basic|Bearer)\s+[^\s,;"']+/gi, '$1 [REDACTED]'],
  [
    /(["']?(?:x-)?(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)["']?\s*:\s*)["'][^"']*["']/gi,
    '$1"[REDACTED]"',
  ],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [
    /\b((?:x-)?api[_-]?key|access[_-]?token|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
    '$1=[REDACTED]',
  ],
];

function redactText(value: string): string {
  let redacted = value.replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, '://[REDACTED]@');
  for (const [pattern, replacement] of VALUE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function record(
  value: JsonValue | undefined,
): { readonly [key: string]: JsonValue } | undefined {
  return value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === 'object'
    ? (value as { readonly [key: string]: JsonValue })
    : undefined;
}

function safeString(
  source: { readonly [key: string]: JsonValue } | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? redactText(value) : undefined;
}

function safeStrings(
  source: { readonly [key: string]: JsonValue } | undefined,
  key: string,
): readonly string[] | undefined {
  const value = source?.[key];
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map(redactText)
    : undefined;
}

/** The repository layer caps a list at 100; asking for more is not a page. */
const ACTIVE_RUN_PAGE = 100;

/** Chains bounded by config, or by the schema default when it says nothing. */
const DEFAULT_CHAIN_MAX_DEPTH = 3;

function chainDepthLimit(configRevision: ConfigRevision | undefined): number {
  if (configRevision === undefined) return DEFAULT_CHAIN_MAX_DEPTH;
  try {
    return (
      parseAgentOsConfig(configRevision.config).chains?.maxDepth ??
      DEFAULT_CHAIN_MAX_DEPTH
    );
  } catch {
    // An unreadable revision cannot widen the bound; a run whose config does
    // not parse fails later on its own terms, not by chaining further.
    return DEFAULT_CHAIN_MAX_DEPTH;
  }
}

/**
 * Strips every `variables` map out of a value before it is described.
 *
 * Masking the leaf path alone is not enough: removing or adding a whole
 * environment produces one change whose value is the entire environment
 * object, `variables` included. That is the same credential leaving by a
 * wider door.
 */
function withoutVariableValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVariableValues);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (
      key === 'variables' &&
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry)
    ) {
      result[key] = Object.fromEntries(
        Object.keys(entry as Record<string, unknown>).map((name) => [
          name,
          REDACTED_VALUE,
        ]),
      );
      continue;
    }
    result[key] = withoutVariableValues(entry);
  }
  return result;
}

/**
 * A config value as one short line. Anything that could be a credential is
 * masked: a plan is rendered into a browser session, while the canonical
 * config itself is withheld from one.
 */
function describeConfigValue(path: string, value: unknown): string {
  if (/^environments\.[^.]+\.variables(\.|$)/.test(path)) return REDACTED_VALUE;
  if (value === null) return 'null';
  if (typeof value === 'string') return value.slice(0, 200);
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(withoutVariableValues(value)).slice(0, 200);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJsonValue(value)).digest('hex');
}

function configurationProjection(
  revision: ConfigRevision,
  includeCanonical = true,
): ConfigurationProjection {
  return {
    ...(includeCanonical
      ? { canonicalConfig: canonicalJsonValue(revision.config) }
      : {}),
    projectId: revision.projectId,
    digest: revision.configDigest,
    revision: revision.revision,
    appliedAt: revision.createdAt,
    provenance: {
      repositorySha: revision.repositorySha,
      configDigest: revision.configDigest,
      modelDigest: revision.modelDigest,
      promptDigest: revision.promptDigest,
      environmentDigest: revision.environmentDigest,
      policyDigest: revision.policyDigest,
    },
  };
}

function configurationDigests(
  config: AgentOsConfig,
  repositorySha: string,
): Omit<PersistenceDigests, 'configDigest'> {
  return {
    modelDigest: fingerprint(config.models),
    promptDigest: fingerprint(
      Object.fromEntries(
        Object.entries(config.agents).map(([name, agent]) => [
          name,
          agent.prompt ?? '',
        ]),
      ),
    ),
    environmentDigest: fingerprint(config.environments),
    policyDigest: canonicalPublicationPolicyDigest(
      normalizePublicationPolicySnapshot({
        version: 'publication-policy-v1',
        protectedPaths: config.policies.protectedPaths,
        maxFiles: 100,
        maxFileBytes: config.policies.maxFileBytes,
        maxTotalBytes: 5_000_000,
        allowBinary: config.policies.allowBinary,
        allowSymlinks: config.policies.allowSymlinks,
        allowDeletes: true,
        allowedModes: ['100644', '100755'],
      }),
    ),
    repositorySha,
  };
}

export interface SafeInboxContent {
  readonly text?: string;
  readonly question?: string;
  readonly message?: string;
  readonly answer?: string;
  readonly options?: readonly string[];
}

export interface InboxProjection {
  readonly id: string;
  readonly runId: string;
  readonly stepRunId?: string;
  readonly status: InboxMessage['status'];
  readonly body: SafeInboxContent;
  readonly reply?: SafeInboxContent;
  readonly createdAt: IsoTimestamp;
  readonly repliedAt?: IsoTimestamp;
}

export interface ReviewOutcome {
  /** Which review produced it: `review` or `review-after-fix`. */
  readonly stepId: string;
  readonly decision: string;
  readonly findings: readonly string[];
}

export interface ApprovalSummary {
  readonly title?: string;
  readonly requirements?: readonly string[];
  readonly criteria?: readonly {
    readonly id: string;
    readonly description: string;
  }[];
  readonly acceptanceTests?: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

export interface ApprovalProjection {
  readonly id: string;
  readonly runId: string;
  readonly scopeHash: string;
  readonly scopePreview: string;
  readonly status: Approval['status'];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly consumedAt?: IsoTimestamp;
  readonly summary?: ApprovalSummary;
}

/** An approval enriched for the inbox: resolved ones carry their decision. */
export interface InboxApprovalItem extends ApprovalProjection {
  readonly decision?: 'approved' | 'rejected';
  readonly projectName?: string;
}

/**
 * A system notification synthesized from a terminal run row — the inbox's
 * "Run complete / Run failed" entries. Derived at read time from durable run
 * records rather than emitted by the worker, so history is retroactive.
 */
export interface RunNotificationProjection {
  readonly runId: string;
  readonly pipeline: string;
  readonly title?: string;
  readonly runStatus: 'succeeded' | 'failed' | 'cancelled';
  /** Workflow result status: succeeded/rejected/expired/budget_exhausted/failed. */
  readonly resultStatus?: string;
  readonly reason?: string;
  readonly outcome?: RunProjection['outcome'];
  readonly totalCostUsd?: number;
  readonly projectName?: string;
  readonly completedAt: IsoTimestamp;
}

export interface InboxDigest {
  readonly approvals: readonly InboxApprovalItem[];
  readonly messages: readonly (InboxProjection & {
    readonly projectName?: string;
  })[];
  readonly notifications: readonly RunNotificationProjection[];
}

const TERMINAL_RUN_STATUSES = new Set<string>([
  'succeeded',
  'failed',
  'cancelled',
]);
/** Spend lookups are the digest's only per-run usage queries; cap them. */
const NOTIFICATION_SPEND_LOOKUPS = 20;

/**
 * The Neon HTTP driver opens a server backend per in-flight query and the
 * compute allows ~112 connections; an unbounded Promise.all across 50 runs
 * has taken the inbox down. Every digest fan-out goes through this bound.
 */
const DIGEST_QUERY_CONCURRENCY = 8;
const ATTENTION_COUNT_PAGE = 100;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      async (): Promise<void> => {
        while (next < items.length) {
          const index = next;
          next += 1;
          results[index] = await worker(items[index]!);
        }
      },
    ),
  );
  return results;
}

async function countTimestampedPages<
  Item extends { readonly id: string; readonly createdAt: IsoTimestamp },
>(
  listPage: (
    after: TimestampListCursor<Item['id']> | undefined,
  ) => Promise<readonly Item[]>,
  include: (item: Item) => boolean = () => true,
): Promise<number> {
  let after: TimestampListCursor<Item['id']> | undefined;
  let count = 0;
  while (true) {
    const page = await listPage(after);
    count += page.filter(include).length;
    if (page.length < ATTENTION_COUNT_PAGE) return count;
    const last = page[page.length - 1]!;
    after = { at: last.createdAt, id: last.id };
  }
}

/**
 * Expiry is a deadline, not a stored fact. `status` only becomes 'expired'
 * when workflow reconciliation gets around to writing it, and that runs on a
 * cron -- so between the deadline passing and the next sweep, a dead approval
 * still reads as 'pending'. The inbox then offers Approve/Reject on it, and
 * the click fails in SQL, where the guard *does* compare the clock.
 *
 * Deriving it here puts every reader on the same footing as that guard:
 * the inbox stops offering an impossible decision, and the attention count
 * stops counting it. Reconciliation still writes the column; this just stops
 * the read path from trusting it while it is stale.
 */
function projectApproval(
  approval: Approval,
  now: IsoTimestamp,
): ApprovalProjection {
  const expired =
    approval.status === 'pending' &&
    Date.parse(approval.expiresAt) <= Date.parse(now);
  return {
    id: approval.id,
    runId: approval.runId,
    scopeHash: approval.fingerprint,
    scopePreview: redactText(approval.scope).slice(0, 240),
    status: expired ? 'expired' : approval.status,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    ...(approval.consumedAt === undefined
      ? {}
      : { consumedAt: approval.consumedAt }),
  };
}

function projectInboxContent(value: JsonValue | undefined): SafeInboxContent {
  if (typeof value === 'string') return { text: redactText(value) };
  const source = record(value);
  const text = safeString(source, 'text');
  const question = safeString(source, 'question');
  const message = safeString(source, 'message');
  const answer = safeString(source, 'answer');
  const options = safeStrings(source, 'options');
  return {
    ...(text === undefined ? {} : { text }),
    ...(question === undefined ? {} : { question }),
    ...(message === undefined ? {} : { message }),
    ...(answer === undefined ? {} : { answer }),
    ...(options === undefined ? {} : { options }),
  };
}

function projectInboxMessage(message: InboxMessage): InboxProjection {
  return {
    id: message.id,
    runId: message.runId,
    ...(message.stepRunId === undefined
      ? {}
      : { stepRunId: message.stepRunId }),
    status: message.status,
    body: projectInboxContent(message.body),
    ...(message.reply === undefined
      ? {}
      : { reply: projectInboxContent(message.reply) }),
    createdAt: message.createdAt,
    ...(message.repliedAt === undefined
      ? {}
      : { repliedAt: message.repliedAt }),
  };
}

function goalDefinitions(
  criteria: readonly CommandCriterion[],
): readonly JsonValue[] {
  if (criteria.length < 1 || criteria.length > 20)
    throw new ServiceError(
      'invalid_goal_criteria',
      'goal criteria must contain between 1 and 20 command checks',
      422,
    );
  const ids = new Set<string>();
  return criteria.map((criterion) => {
    if (
      criterion.type !== 'command' ||
      typeof criterion.id !== 'string' ||
      criterion.id.trim().length === 0 ||
      typeof criterion.description !== 'string' ||
      criterion.description.trim().length === 0 ||
      typeof criterion.command !== 'string' ||
      criterion.command.trim().length === 0 ||
      ids.has(criterion.id)
    )
      throw new ServiceError(
        'invalid_goal_criteria',
        'goal command criteria must be complete and have unique IDs',
        422,
      );
    ids.add(criterion.id);
    return JSON.parse(canonicalJsonValue(criterion)) as JsonValue;
  });
}

/**
 * The command criteria a goal run was started with, read back from its
 * immutable input. Commands never travel through the browser for this --
 * the run already holds the exact allowlist keys it was admitted with.
 */
function restartCriteria(
  value: JsonValue | undefined,
): readonly CommandCriterion[] {
  if (!Array.isArray(value))
    throw new ServiceError(
      'run_not_restartable',
      'this goal run did not record its criteria',
      409,
    );
  return value.map((entry) => {
    const criterion = record(entry);
    const id = criterion?.id;
    const description = criterion?.description;
    const command = criterion?.command;
    const required = criterion?.required;
    if (
      typeof id !== 'string' ||
      typeof description !== 'string' ||
      typeof command !== 'string'
    )
      throw new ServiceError(
        'run_not_restartable',
        'this goal run recorded a criterion that cannot be replayed',
        409,
      );
    return {
      id,
      type: 'command' as const,
      description,
      command,
      ...(typeof required === 'boolean' ? { required } : {}),
    };
  });
}

function inputForRun(
  idempotencyKey: string,
  input: CreateRunInput | CreateGoalRunInput,
  chain?: RunChain,
): JsonValue {
  return {
    idempotencyKey,
    title: input.title,
    description: input.description,
    // The resolved edge, not the requested one: baseBranch and
    // baseCommitSha come from the base run's publication record, so nothing
    // downstream has to trust -- or re-derive -- what the caller asked for.
    ...(chain === undefined
      ? {}
      : {
          chain: {
            baseRunId: chain.baseRunId,
            baseBranch: chain.baseBranch,
            baseCommitSha: chain.baseCommitSha,
          },
        }),
    provenance: {
      repositorySha: input.repositorySha,
      configDigest: input.configDigest,
      modelDigest: input.modelDigest,
      promptDigest: input.promptDigest,
      environmentDigest: input.environmentDigest,
      policyDigest: input.policyDigest,
    },
    ...('criteria' in input
      ? { criteria: goalDefinitions(input.criteria) }
      : {}),
  };
}

export interface BacklogProjection {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: BacklogStatus;
  readonly pausedReason?: string;
  readonly items: readonly {
    readonly id: string;
    readonly ordinal: number;
    readonly title: string;
    readonly status: BacklogItemStatus;
    readonly runId?: string;
  }[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface RunProjection extends PersistenceDigests {
  readonly id: string;
  readonly projectId: string;
  readonly pipeline: string;
  readonly status: RunStatus;
  readonly input?: {
    readonly title?: string;
    readonly description?: string;
  };
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: readonly string[];
  };
  readonly goal?: {
    readonly maxSteps: number;
    readonly currentStep: number;
    readonly criteria: readonly {
      readonly id: string;
      readonly description: string;
      readonly required: boolean;
    }[];
    readonly latestResults: readonly {
      readonly criterionId: string;
      readonly step: number;
      readonly status: 'passed' | 'failed';
      readonly code?: string;
    }[];
    readonly children: readonly {
      readonly step: number;
      readonly runId: string;
      readonly status?: RunStatus;
      readonly draftPullRequestUrl?: string;
    }[];
  };
  readonly outcome?: {
    readonly draftPullRequestUrl?: string;
    readonly localBranch?: string;
    readonly localRepositoryUrl?: string;
    /** Where this run published, and therefore what can be built on it. */
    readonly publishedBranch?: string;
    readonly publishedCommitSha?: string;
  };
  /** Set when this run was started on top of an earlier run's publication. */
  readonly chain?: {
    readonly baseRunId: string;
    readonly baseBranch: string;
    readonly baseCommitSha: string;
  };
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly steps: readonly {
    id: string;
    stepKey: string;
    attempt: number;
    status: string;
    model?: string;
    progress: readonly {
      readonly eventId: string;
      readonly phase: string;
      readonly message: string;
      readonly occurredAt: IsoTimestamp;
    }[];
  }[];
  readonly timeline: readonly {
    eventId: string;
    sequence: number;
    type: string;
    payload?: {
      readonly approvalId?: string;
      readonly scopeHash?: string;
      readonly messageId?: string;
      readonly status?: string;
      readonly decision?: string;
      readonly message?: string;
      readonly summary?: string;
      readonly details?: readonly string[];
      readonly options?: readonly string[];
    };
    occurredAt: IsoTimestamp;
  }[];
}

function projectRunInput(value: JsonValue | undefined): RunProjection['input'] {
  const source = record(value);
  const title = safeString(source, 'title');
  const description = safeString(source, 'description');
  if (title === undefined && description === undefined) return undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * Run output is agent-influenced, and the draft PR URL renders as a live
 * anchor — only http(s) URLs may pass, exactly like the goal-children
 * mapping, so a hostile `javascript:` value can never become an href.
 */
function safeHttpUrl(
  source: { readonly [key: string]: JsonValue } | undefined,
  key: string,
): string | undefined {
  const candidate = safeString(source, key);
  if (candidate === undefined || candidate.length > 2_048) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The chain edge as the operator needs to read it. It comes from the
 * immutable run input, which the control plane wrote from the base run's
 * own publication record, so nothing agent-influenced reaches the page.
 */
function projectRunChain(value: JsonValue | undefined): RunProjection['chain'] {
  const chain = record(record(value)?.chain);
  const baseRunId = chain?.baseRunId;
  const baseBranch = chain?.baseBranch;
  const baseCommitSha = chain?.baseCommitSha;
  if (
    typeof baseRunId !== 'string' ||
    typeof baseBranch !== 'string' ||
    typeof baseCommitSha !== 'string'
  )
    return undefined;
  return { baseRunId, baseBranch, baseCommitSha };
}

function projectRunOutcome(
  value: JsonValue | undefined,
): RunProjection['outcome'] {
  const source = record(value);
  const draftPullRequestUrl = safeHttpUrl(source, 'draftPullRequestUrl');
  const localBranch = safeString(source, 'localBranch');
  const localRepositoryUrl = safeString(source, 'localRepositoryUrl');
  const publishedBranch = safeString(source, 'publishedBranch');
  // A commit is a hex string or it is nothing: a chained run is started from
  // this value, so a malformed one must not reach a start form as an offer.
  const rawCommit = safeString(source, 'publishedCommitSha');
  const publishedCommitSha =
    rawCommit !== undefined && /^[a-f0-9]{40}$/i.test(rawCommit)
      ? rawCommit
      : undefined;
  if (
    draftPullRequestUrl === undefined &&
    localBranch === undefined &&
    localRepositoryUrl === undefined &&
    publishedBranch === undefined &&
    publishedCommitSha === undefined
  )
    return undefined;
  return {
    ...(draftPullRequestUrl === undefined ? {} : { draftPullRequestUrl }),
    ...(localBranch === undefined ? {} : { localBranch }),
    ...(localRepositoryUrl === undefined ? {} : { localRepositoryUrl }),
    ...(publishedBranch === undefined ? {} : { publishedBranch }),
    ...(publishedCommitSha === undefined ? {} : { publishedCommitSha }),
  };
}

function projectRunError(value: JsonValue | undefined): RunProjection['error'] {
  const source = record(value);
  const code = safeString(source, 'code');
  const message = safeString(source, 'message');
  const details = safeStrings(source, 'details');
  if (code === undefined && message === undefined && details === undefined)
    return undefined;
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(details === undefined ? {} : { details }),
  };
}

function projectEventPayload(
  value: JsonValue | undefined,
): RunProjection['timeline'][number]['payload'] {
  const source = record(value);
  if (source === undefined) return undefined;
  const strings = Object.fromEntries(
    [
      'approvalId',
      'scopeHash',
      'messageId',
      'status',
      'decision',
      'message',
      'summary',
    ]
      .map((key) => [key, safeString(source, key)] as const)
      .filter(
        (entry): entry is readonly [string, string] => entry[1] !== undefined,
      ),
  );
  const details = safeStrings(source, 'details');
  const options = safeStrings(source, 'options');
  if (
    Object.keys(strings).length === 0 &&
    details === undefined &&
    options === undefined
  )
    return undefined;
  return {
    ...strings,
    ...(details === undefined ? {} : { details }),
    ...(options === undefined ? {} : { options }),
  };
}

const STEP_PROGRESS_PHASES = new Set([
  'preparing',
  'sending',
  'waiting',
  'working',
  'tool',
  'validating',
  'retrying',
  'completed',
  'failed',
]);

function projectStepProgress(event: DomainEvent):
  | (RunProjection['steps'][number]['progress'][number] & {
      readonly stepRunId: string;
      readonly stepKey: string;
      readonly attempt: number;
      readonly sequence: number;
    })
  | undefined {
  if (event.type !== 'step.progress') return undefined;
  const source = record(event.payload);
  if (source === undefined) return undefined;
  const stepRunId = safeString(source, 'stepRunId');
  const stepKey = safeString(source, 'stepKey');
  const phase = safeString(source, 'phase');
  const message = safeString(source, 'message');
  const attempt = source.attempt;
  if (
    stepRunId === undefined ||
    stepKey === undefined ||
    phase === undefined ||
    !STEP_PROGRESS_PHASES.has(phase) ||
    message === undefined ||
    typeof attempt !== 'number' ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    return undefined;
  return {
    eventId: event.eventId,
    stepRunId,
    stepKey,
    attempt,
    sequence: event.sequence,
    phase,
    message,
    occurredAt: event.occurredAt,
  };
}

function provenance(run: WorkflowRun): PersistenceDigests {
  const inputValue =
    run.input && !Array.isArray(run.input) && typeof run.input === 'object'
      ? run.input
      : {};
  const input = inputValue as { readonly [key: string]: JsonValue };
  const raw = input.provenance;
  const sourceValue =
    raw && !Array.isArray(raw) && typeof raw === 'object' ? raw : {};
  const source = sourceValue as { readonly [key: string]: JsonValue };
  const read = (key: keyof PersistenceDigests) =>
    typeof source[key] === 'string' ? source[key] : '';
  return {
    repositorySha: read('repositorySha'),
    configDigest: read('configDigest'),
    modelDigest: read('modelDigest'),
    promptDigest: read('promptDigest'),
    environmentDigest: read('environmentDigest'),
    policyDigest: read('policyDigest'),
  };
}

export class ControlPlaneService {
  constructor(
    private readonly repository: DomainRepository,
    private readonly clock: () => IsoTimestamp,
    private readonly generateId: IdGenerator,
    private readonly workflowDispatch?: WorkflowDispatchOutbox,
    private readonly repositoryHead?: {
      resolve(config: AgentOsConfig): Promise<string>;
    },
    private readonly trustedGoalCommands?: ReadonlySet<string>,
    private readonly deploymentRegistryHosts: readonly string[] = [],
    private readonly artifacts?: {
      get(input: {
        readonly scope: {
          readonly projectId: string;
          readonly runId: string;
          readonly stepId: string;
        };
        readonly key: string;
        readonly maxBytes: number;
      }): Promise<{ readonly bytes: Uint8Array } | undefined>;
      list(input: {
        readonly scope: {
          readonly projectId: string;
          readonly runId: string;
          readonly stepId: string;
        };
        readonly limit: number;
      }): Promise<{
        readonly items: readonly {
          readonly artifactId: string;
          readonly key: string;
        }[];
      }>;
    },
    private readonly projectSources?: ProjectSourceGateway,
    private readonly runResumption?: RunResumptionStore,
  ) {}

  private requireProjectSources(): ProjectSourceGateway {
    if (this.projectSources === undefined)
      throw new ServiceError(
        'project_source_unavailable',
        'Project source inspection is not configured',
        503,
      );
    return this.projectSources;
  }

  async getUserPreferences(
    login: string,
  ): Promise<UserPreferencesProjection | undefined> {
    const preferences = await this.repository.getUserPreferences(login);
    return preferences === undefined
      ? undefined
      : {
          timeZone: preferences.timeZone,
          updatedAt: preferences.updatedAt,
        };
  }

  async updateUserTimeZone(
    login: string,
    timeZone: string,
  ): Promise<UserPreferencesProjection> {
    if (!isValidTimeZone(timeZone)) {
      throw new ServiceError(
        'invalid_time_zone',
        'time zone must be a valid IANA identifier',
        422,
      );
    }
    const preferences: UserPreferences = {
      login,
      timeZone,
      updatedAt: this.clock(),
    };
    const saved = await this.repository.upsertUserPreferences(preferences);
    return { timeZone: saved.timeZone, updatedAt: saved.updatedAt };
  }

  private projectSourceFailure(error: unknown): never {
    const code =
      typeof error === 'object' && error !== null
        ? Reflect.get(error, 'code')
        : undefined;
    const known: Readonly<Record<string, { message: string; status: number }>> =
      {
        invalid_repository_url: {
          message: 'Use a canonical https://github.com/owner/repository URL',
          status: 422,
        },
        invalid_path: {
          message: 'Enter an existing absolute local path',
          status: 422,
        },
        not_a_repository: {
          message: 'Choose a non-bare Git working tree',
          status: 422,
        },
        not_top_level: {
          message:
            'Choose the exact top-level directory of the Git working tree',
          status: 422,
        },
        unavailable_branch: {
          message: 'The selected branch is unavailable',
          status: 422,
        },
        missing_reader_installation: {
          message:
            'Install the AgentOS reader GitHub App on this repository first',
          status: 409,
        },
        repository_mismatch: {
          message: 'The repository identity changed during inspection',
          status: 409,
        },
        invalid_cursor: {
          message: 'The commit cursor is invalid',
          status: 422,
        },
        provider_unavailable: {
          message: 'Repository history is temporarily unavailable',
          status: 502,
        },
      };
    const failure = typeof code === 'string' ? known[code] : undefined;
    if (failure !== undefined)
      throw new ServiceError(code as string, failure.message, failure.status);
    throw new ServiceError(
      'project_source_unavailable',
      'Repository inspection is temporarily unavailable',
      502,
    );
  }

  private bindingKey(config: AgentOsConfig): string {
    if (config.project.repository !== undefined)
      return `repository:${config.project.repository}`;
    if (config.project.localPath !== undefined)
      return `localPath:${config.project.localPath}`;
    return `name:${config.project.name}`;
  }

  /**
   * Deterministic project identity from a binding key, with one carve-out:
   * deployments that predate multi-project keep their constant-id project
   * (and its whole revision history) as long as its latest revision still
   * carries the same binding.
   */
  private async projectIdForBindingKey(
    key: string,
  ): Promise<PersistenceId<'project'>> {
    const derived = this.generateId('project', `binding:${key}`);
    if ((await this.repository.getProject(derived)) !== undefined)
      return derived;
    const legacyId = this.generateId('project', 'configuration');
    const legacy = await this.repository.getProject(legacyId);
    if (legacy !== undefined) {
      const latest = await this.repository.getLatestConfigRevision(legacyId);
      if (latest !== undefined) {
        try {
          if (this.bindingKey(parseAgentOsConfig(latest.config)) === key)
            return legacyId;
        } catch {
          // An unparseable legacy revision never captures new applies.
        }
      }
    }
    return derived;
  }

  private async resolveProjectId(
    selector: ProjectSelector,
  ): Promise<PersistenceId<'project'> | undefined> {
    if (selector.projectId !== undefined) {
      const id = persistenceId('project', selector.projectId);
      if ((await this.repository.getProject(id)) === undefined)
        throw new ServiceError('project_not_found', 'project not found', 404);
      return id;
    }
    if (selector.repository !== undefined)
      return this.projectIdForBindingKey(`repository:${selector.repository}`);
    if (selector.localPath !== undefined)
      return this.projectIdForBindingKey(`localPath:${selector.localPath}`);
    if (selector.name !== undefined)
      return this.projectIdForBindingKey(`name:${selector.name}`);
    const projects = await this.repository.listProjects({ limit: 2 });
    if (projects.length > 1)
      throw new ServiceError(
        'project_required',
        'multiple projects exist; select one with projectId, repository, localPath, or name',
        400,
      );
    return projects[0]?.id;
  }

  async inspectProjectSource(
    input: ProjectSourceImportInput,
  ): Promise<ProjectSourceInspection> {
    try {
      return (await this.requireProjectSources().inspect(input)).inspection;
    } catch (error) {
      this.projectSourceFailure(error);
    }
  }

  async importProjectSource(
    idempotencyKey: string,
    input: ProjectSourceImportInput,
  ): Promise<ProjectSourceImportResult> {
    if (idempotencyKey.trim().length === 0 || idempotencyKey.length > 200)
      throw new ServiceError(
        'idempotency_key_required',
        'Idempotency-Key header is required',
        400,
      );
    let inspected: Awaited<ReturnType<ProjectSourceGateway['inspect']>>;
    try {
      inspected = await this.requireProjectSources().inspect(input);
    } catch (error) {
      this.projectSourceFailure(error);
    }

    const configuredBinding =
      inspected.source.kind === 'github'
        ? `repository:${inspected.source.repositoryUrl}`
        : `localPath:${inspected.source.localPath}`;
    const configuredProjectId =
      await this.projectIdForBindingKey(configuredBinding);
    const configuredProject =
      await this.repository.getProject(configuredProjectId);
    const projectId =
      configuredProject === undefined
        ? this.generateId('project', `binding:${inspected.source.sourceKey}`)
        : configuredProjectId;
    const at = this.clock();
    const project: Project = configuredProject ?? {
      id: projectId,
      name: inspected.inspection.suggestedName,
      ...(inspected.source.kind === 'github'
        ? { repository: inspected.source.repositoryUrl }
        : {}),
      createdAt: at,
      updatedAt: at,
    };
    const source: ProjectSource = {
      ...inspected.source,
      projectId,
      createdAt: at,
      updatedAt: at,
    } as ProjectSource;
    try {
      return await this.repository.importProjectSource(project, source, {
        idempotencyKey,
        fingerprint: fingerprint(input),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'IdempotencyConflictError')
        throw new ServiceError(
          'idempotency_conflict',
          'idempotency key was already used with another project source',
          409,
        );
      if (
        error instanceof Error &&
        error.name === 'ProjectSourceIdentityConflictError'
      )
        throw new ServiceError(
          'project_source_identity_conflict',
          'repository identity is already attached to another project source',
          409,
        );
      throw error;
    }
  }

  async listProjectCommits(
    projectId: string,
    cursor?: string,
  ): Promise<CommitPage> {
    const id = persistenceId('project', projectId);
    if ((await this.repository.getProject(id)) === undefined)
      throw new ServiceError('project_not_found', 'project not found', 404);
    const source = await this.repository.getProjectSource(id);
    if (source === undefined)
      throw new ServiceError(
        'project_source_not_found',
        'This project has no imported source',
        404,
      );
    try {
      return await this.requireProjectSources().listCommits(source, cursor);
    } catch (error) {
      this.projectSourceFailure(error);
    }
  }

  /** Lightweight project count for navigation badges. */
  async countProjects(limit = 1_000): Promise<number> {
    return (await this.repository.listProjects({ limit })).length;
  }

  private projectBindingLabel(
    project: Project,
    revision: ConfigRevision | undefined,
  ): string {
    if (revision !== undefined) {
      try {
        const config = parseAgentOsConfig(revision.config);
        if (config.project.repository !== undefined)
          return redactText(config.project.repository);
        if (config.project.localPath !== undefined)
          return redactText(config.project.localPath);
      } catch {
        // Fall back to the durable project row when revision config is unreadable.
      }
    }
    if (project.repository !== undefined) return redactText(project.repository);
    return redactText(project.name);
  }

  private async projectListProjection(
    project: Project,
  ): Promise<ProjectListProjection> {
    // countRuns is an exact aggregate: listing to count saturates at the
    // repository page cap, so a busy project's total would stop moving. The
    // listing here only needs the newest row for last-run status.
    const [latest, runCount, runs] = await Promise.all([
      this.repository.getLatestConfigRevision(project.id),
      this.repository.countRuns({ projectId: project.id }),
      this.repository.listRuns({
        projectId: project.id,
        limit: 1,
        order: 'desc',
      }),
    ]);
    const lastRun = runs[0];
    return {
      id: project.id,
      name: redactText(project.name).slice(0, 120),
      binding: this.projectBindingLabel(project, latest),
      ...(latest === undefined
        ? {}
        : {
            latestRevision: latest.revision,
            configDigest: latest.configDigest,
          }),
      ...(lastRun === undefined
        ? {}
        : {
            lastRunStatus: lastRun.status,
            lastRunAt: lastRun.updatedAt,
          }),
      runCount,
      updatedAt: project.updatedAt,
    };
  }

  async listProjects(limit = 100): Promise<readonly ProjectListProjection[]> {
    const projects = await this.repository.listProjects({ limit });
    return mapWithConcurrency(projects, DIGEST_QUERY_CONCURRENCY, (project) =>
      this.projectListProjection(project),
    );
  }

  async getProjectDetail(projectId: string): Promise<ProjectDetailProjection> {
    const id = persistenceId('project', projectId);
    const project = await this.repository.getProject(id);
    if (project === undefined)
      throw new ServiceError('project_not_found', 'project not found', 404);
    const [summary, recentRuns, latest, projectSource] = await Promise.all([
      this.projectListProjection(project),
      this.listRuns(6, projectId),
      this.repository.getLatestConfigRevision(id),
      this.repository.getProjectSource(id),
    ]);
    let workflowBudgetMicrodollars: number | undefined;
    let dailyBudgetMicrodollars: number | undefined;
    if (latest !== undefined) {
      try {
        const config = parseAgentOsConfig(latest.config);
        workflowBudgetMicrodollars = config.budgets.workflowMicrodollars;
        dailyBudgetMicrodollars = config.budgets.dailyMicrodollars;
      } catch {
        // Budget labels are decoration; unreadable config must not break the page.
      }
    }
    let headSha: string | undefined;
    if (latest !== undefined && this.repositoryHead !== undefined) {
      try {
        headSha = await this.repositoryHead.resolve(
          parseAgentOsConfig(latest.config),
        );
      } catch {
        // A reader that is unavailable, unconfigured, or looking at a repo
        // that moved must not take the page down with it. Unknown drift
        // renders as no claim rather than a false "up to date".
      }
    }
    return {
      ...summary,
      ...(workflowBudgetMicrodollars === undefined
        ? {}
        : { workflowBudgetMicrodollars }),
      ...(dailyBudgetMicrodollars === undefined
        ? {}
        : { dailyBudgetMicrodollars }),
      ...(latest === undefined ? {} : { appliedSha: latest.repositorySha }),
      ...(headSha === undefined ? {} : { headSha }),
      ...(latest === undefined || headSha === undefined
        ? {}
        : { drifted: headSha !== latest.repositorySha }),
      ...(projectSource === undefined
        ? {}
        : {
            source: {
              kind: projectSource.kind,
              location:
                projectSource.kind === 'github'
                  ? projectSource.repositoryUrl
                  : projectSource.localPath,
              defaultBranch: projectSource.defaultBranch,
              ...(projectSource.kind === 'github'
                ? {
                    publisherReady:
                      projectSource.publisherInstallationId !== undefined,
                  }
                : {}),
            },
          }),
      recentRuns,
    };
  }

  async getConfiguration(
    includeCanonical = true,
    selector: ProjectSelector = {},
  ): Promise<{
    readonly active: ConfigurationProjection | null;
    readonly projectId?: string;
  }> {
    const projectId = await this.resolveProjectId(selector);
    if (projectId === undefined) return { active: null };
    const active = await this.repository.getLatestConfigRevision(projectId);
    return {
      projectId,
      active:
        active === undefined
          ? null
          : configurationProjection(active, includeCanonical),
    };
  }

  async getConfigurationForConfig(
    config: AgentOsConfig,
    includeCanonical = false,
  ): Promise<{
    readonly projectId: string;
    readonly active: ConfigurationProjection | null;
  }> {
    const projectId = await this.projectIdForBindingKey(
      this.bindingKey(config),
    );
    const active = await this.repository.getLatestConfigRevision(projectId);
    return {
      projectId,
      active:
        active === undefined
          ? null
          : configurationProjection(active, includeCanonical),
    };
  }

  /**
   * What applying this YAML would change, without applying it and without
   * echoing what is stored.
   *
   * `GET /api/configuration` withholds the canonical config from session
   * callers because `environments[].variables` is free-form and may hold
   * credentials. A diff would smuggle those values back out through its
   * `before` side, so values under that path are masked here on the way out
   * -- the same rule the configuration page already renders by. Every other
   * path in an Agent OS config names models, budgets, pipelines, and
   * policies, which are the whole point of reading a plan.
   */
  async planConfigurationChange(yaml: string): Promise<{
    readonly projectId: string;
    readonly changed: boolean;
    readonly fromRevision: number | null;
    readonly changes: readonly {
      readonly kind: 'added' | 'removed' | 'changed';
      readonly path: string;
      readonly before?: string;
      readonly after?: string;
    }[];
  }> {
    let config: AgentOsConfig;
    try {
      config = loadAgentOsConfig(yaml);
    } catch (error) {
      throw new ServiceError(
        'invalid_configuration',
        error instanceof Error
          ? error.message.slice(0, 2_000)
          : 'invalid configuration',
        422,
      );
    }
    const projectId = await this.projectIdForBindingKey(
      this.bindingKey(config),
    );
    const active = await this.repository.getLatestConfigRevision(projectId);
    if (active === undefined)
      return { projectId, changed: true, fromRevision: null, changes: [] };
    const plan = planConfigChange(parseAgentOsConfig(active.config), config);
    return {
      projectId,
      changed: plan.changed,
      fromRevision: active.revision,
      changes: plan.changes.slice(0, 200).map((change) => ({
        kind: change.kind,
        path: change.path,
        ...(change.before === undefined
          ? {}
          : { before: describeConfigValue(change.path, change.before) }),
        ...(change.after === undefined
          ? {}
          : { after: describeConfigValue(change.path, change.after) }),
      })),
    };
  }

  async applyConfiguration(
    idempotencyKey: string,
    input: ConfigurationInput,
  ): Promise<ConfigurationProjection> {
    let config: AgentOsConfig;
    try {
      config = loadAgentOsConfig(input.canonicalConfig);
    } catch {
      throw new ServiceError(
        'configuration_invalid',
        'configuration did not match the v1 schema',
        422,
      );
    }
    const canonicalConfig = canonicalConfigJson(config);
    const digest = canonicalConfigHash(config);
    if (input.canonicalConfig !== canonicalConfig) {
      throw new ServiceError(
        'configuration_not_canonical',
        'configuration must use canonical JSON',
        422,
      );
    }
    if (input.digest !== digest) {
      throw new ServiceError(
        'configuration_digest_mismatch',
        'configuration digest does not match the payload',
        422,
      );
    }
    if ((input.expectedRevision === null) !== (input.expectedDigest === null)) {
      throw new ServiceError(
        'configuration_invalid',
        'configuration precondition is invalid',
        422,
      );
    }
    const revisionId = this.generateId(
      'configRevision',
      `configuration:${idempotencyKey}`,
    );
    const replay = await this.repository.getConfigRevision(revisionId);
    if (replay !== undefined) {
      if (
        replay.configDigest !== digest ||
        canonicalJsonValue(replay.config) !== canonicalConfig
      )
        throw new ServiceError(
          'idempotency_conflict',
          'idempotency key was already used with another configuration',
          409,
        );
      return configurationProjection(replay);
    }
    const now = this.clock();
    let repositorySha: string;
    if (this.repositoryHead !== undefined) {
      try {
        repositorySha = await this.repositoryHead.resolve(config);
      } catch {
        throw new ServiceError(
          'repository_head_unavailable',
          'selected repository default branch could not be resolved',
          503,
        );
      }
      if (!/^[0-9a-f]{40}$/.test(repositorySha))
        throw new ServiceError(
          'repository_head_invalid',
          'selected repository returned an invalid commit SHA',
          503,
        );
    } else {
      if (this.workflowDispatch !== undefined)
        throw new ServiceError(
          'repository_head_required',
          'workflow configuration requires a trusted repository head resolver',
          503,
        );
      repositorySha = fingerprint({
        source: 'unbound-local-configuration',
        configDigest: digest,
      }).slice(0, 40);
    }
    const projectId = await this.projectIdForBindingKey(
      this.bindingKey(config),
    );
    if (input.projectId !== undefined && input.projectId !== projectId)
      throw new ServiceError(
        'project_mismatch',
        'projectId does not match the configuration project',
        409,
      );
    try {
      const revision = await this.repository.applyConfigRevision(
        {
          id: projectId,
          name: config.project.name,
          ...(config.project.repository === undefined
            ? {}
            : { repository: config.project.repository }),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: revisionId,
          projectId,
          config: JSON.parse(canonicalConfig) as JsonValue,
          configDigest: digest,
          ...configurationDigests(config, repositorySha),
          createdAt: now,
        },
        {
          revision: input.expectedRevision,
          digest: input.expectedDigest,
        },
      );
      return configurationProjection(revision);
    } catch (error) {
      if (error instanceof Error && error.name === 'IdempotencyConflictError') {
        throw new ServiceError(
          'idempotency_conflict',
          'idempotency key was already used with another configuration',
          409,
        );
      }
      if (error instanceof Error && error.name === 'StaleConfigurationError') {
        throw new ServiceError(
          'configuration_stale',
          'active configuration changed; plan and apply again',
          409,
        );
      }
      throw error;
    }
  }

  createFeatureRun(idempotencyKey: string, input: CreateRunInput) {
    return this.createRun('feature', idempotencyKey, input);
  }

  /**
   * The commands a goal criterion may name for this project: the deployment
   * allowlist, narrowed by the project's verification policy.
   *
   * Exposed because a goal is only worth authoring against commands that will
   * actually be accepted -- createGoalRun rejects anything else with a 422,
   * and discovering that by submitting a form is a poor way to learn the
   * list. Both callers resolve it the same way, so the picker cannot drift
   * from the check.
   */
  /**
   * Starts a run for a project with provenance resolved from its applied
   * configuration revision, rather than supplied by the caller.
   *
   * The CLI endpoints keep asking for the five digests and the SHA, because
   * a script has them and pinning them is how a stale script fails loudly.
   * A person does not have them, and a form that asked for them would be
   * asking someone to copy hashes between two browser tabs.
   *
   * The SHA is the applied revision's, never the branch head: run creation
   * requires them to match, so using the head would produce a 409 the
   * operator cannot act on. Drift is surfaced on the project page instead.
   */
  async startRunForProject(
    idempotencyKey: string,
    input: {
      readonly projectId: string;
      readonly title: string;
      readonly description: string;
      readonly pipeline: 'feature' | 'goal';
      readonly criteria?: readonly CommandCriterion[] | undefined;
      readonly baseRunId?: string | undefined;
    },
  ): Promise<RunProjection> {
    const revision = await this.repository.getLatestConfigRevision(
      persistenceId('project', input.projectId),
    );
    if (revision === undefined)
      throw new ServiceError(
        'project_unconfigured',
        'apply a configuration for this project before starting a run',
        409,
      );
    const base = {
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      repositorySha: revision.repositorySha,
      configDigest: revision.configDigest,
      modelDigest: revision.modelDigest,
      promptDigest: revision.promptDigest,
      environmentDigest: revision.environmentDigest,
      policyDigest: revision.policyDigest,
      ...(input.baseRunId === undefined ? {} : { baseRunId: input.baseRunId }),
    };
    if (input.pipeline === 'goal') {
      if (input.criteria === undefined || input.criteria.length === 0)
        throw new ServiceError(
          'invalid_goal_criteria',
          'a goal run requires at least one criterion',
          422,
        );
      return this.createGoalRun(idempotencyKey, {
        ...base,
        criteria: input.criteria,
      });
    }
    return this.createFeatureRun(idempotencyKey, base);
  }

  /**
   * Starts the same request again, as a new run.
   *
   * Deliberately not a re-dispatch of the original. Dispatch is a durable,
   * idempotent effect: it returns early once it has succeeded, and Trigger's
   * own idempotency key (`<pipeline>-workflow:<runId>:v1`, kept for thirty
   * days) would hand back the very run that died. Making the same run id
   * executable twice would mean versioning that key, and if the first
   * executor were somehow alive, two paid sessions would share one run --
   * which is exactly what the one-session-per-run posture exists to prevent.
   *
   * So the failed run stays as the record of what happened, and its request
   * is re-issued against whatever configuration is applied *now* -- which is
   * usually the point, since something was changed to make it work.
   */
  async restartRun(
    idempotencyKey: string,
    runId: string,
  ): Promise<RunProjection> {
    const run = await this.repository.getRun(persistenceId('run', runId));
    if (run === undefined)
      throw new ServiceError('not_found', 'run not found', 404);
    if (!['succeeded', 'failed', 'cancelled'].includes(run.status))
      throw new ServiceError(
        'run_not_restartable',
        'this run has not finished; cancel it first, then start it again',
        409,
      );
    if (run.pipeline !== 'feature' && run.pipeline !== 'goal')
      throw new ServiceError(
        'run_not_restartable',
        'only feature and goal runs can be started again',
        409,
      );
    const input = record(run.input);
    const title = typeof input?.title === 'string' ? input.title : undefined;
    const description =
      typeof input?.description === 'string' ? input.description : undefined;
    if (title === undefined || description === undefined)
      throw new ServiceError(
        'run_not_restartable',
        'this run did not record the request it was started from',
        409,
      );
    // The base run, not the base commit: the chain is resolved again from
    // that run's publication, so a restart cannot pin itself to a commit
    // that has since been superseded.
    const baseRunId = record(input?.chain)?.baseRunId;
    const criteria =
      run.pipeline === 'goal' ? restartCriteria(input?.criteria) : undefined;
    return this.startRunForProject(idempotencyKey, {
      projectId: run.projectId,
      title,
      description,
      pipeline: run.pipeline,
      ...(typeof baseRunId === 'string' ? { baseRunId } : {}),
      ...(criteria === undefined ? {} : { criteria }),
    });
  }

  /**
   * Continues a finished run where it stopped, keeping the steps it already
   * validated.
   *
   * This is the counterpart to `restartRun`, not a replacement for it. A
   * resume re-enters the *same* run, so it reuses that run's pinned
   * configuration and repository snapshot and replays every succeeded step
   * from storage instead of paying a model to redo it. That is what you want
   * when the run died for a reason outside its own inputs -- budget, a
   * provider fault, a crashed worker. When something was *changed* to make the
   * work succeed, the pinned snapshot is precisely wrong and `restartRun` is
   * the right action.
   *
   * Trigger holds a task idempotency key for thirty days, so each resume asks
   * for a fresh generation of both the dispatch effect key and the Trigger
   * key; reusing either would hand back the execution that already finished.
   */
  async resumeRun(runId: string): Promise<RunProjection> {
    if (this.runResumption === undefined)
      throw new ServiceError(
        'run_not_resumable',
        'resuming runs is not configured',
        503,
      );
    const run = await this.repository.getRun(persistenceId('run', runId));
    if (run === undefined)
      throw new ServiceError('not_found', 'run not found', 404);
    if (run.pipeline !== 'feature' && run.pipeline !== 'goal')
      throw new ServiceError(
        'run_not_resumable',
        'only feature and goal runs can be resumed',
        409,
      );
    // Succeeded runs have nothing left to do, and a run that has not finished
    // may still have a worker on it -- resuming that would put two paid
    // sessions on one run.
    if (run.status !== 'failed' && run.status !== 'cancelled')
      throw new ServiceError(
        'run_not_resumable',
        run.status === 'succeeded'
          ? 'this run already finished'
          : 'this run has not finished; cancel it first, then resume it',
        409,
      );
    const effects = await this.runResumption.listEffects(runId);
    const generation =
      effects.reduce((highest, effect) => {
        const match = /:resume:(\d+)$/.exec(effect.key);
        return match === null
          ? highest
          : Math.max(highest, Number.parseInt(match[1]!, 10));
      }, 0) + 1;
    // Clearing before reopening: a resumed worker that reached a dead-lettered
    // checkpoint would refuse to replay and fail the run all over again.
    await this.runResumption.releaseRunForResume(runId);
    const at = this.clock();
    const reopened = await this.repository.transitionRun(
      run.id,
      ['failed', 'cancelled'],
      // The previous failure is cleared with the status it belonged to. A run
      // that is pending again must not still explain why it failed.
      { status: 'pending', error: null, output: null, updatedAt: at },
      run.stateVersion ?? 0,
    );
    if (reopened === undefined)
      throw new ServiceError(
        'run_not_resumable',
        'this run changed while it was being resumed; try again',
        409,
      );
    // The worker anchors the run's execution deadline at the latest resume,
    // because the clock starts when the operator decides -- a resumed run
    // measured from its original creation would already be out of time.
    await this.repository.appendEvent({
      runId: run.id,
      // Keyed by generation, which is unique per resume by construction --
      // two resumes in the same clock tick must still be two events.
      eventId: persistenceId(
        'event',
        `run-resumed:${runId}:${String(generation)}`,
      ),
      fingerprint: fingerprint(`run-resumed:${runId}:${String(generation)}`),
      type: RUN_RESUMED_EVENT,
      payload: { generation },
      occurredAt: at,
    });
    try {
      await this.workflowDispatch?.requestStart({
        idempotencyKey: `workflow-start:${runId}:resume:${String(generation)}`,
        runId,
        pipeline: run.pipeline,
        resumeGeneration: generation,
      });
    } catch {
      // The reopened run is the durable intent; reconciliation retries it.
    }
    return this.project(reopened);
  }

  /**
   * Grants a run a one-time allowance past the budget that stopped it.
   *
   * The grant is an append-only event on the run, so it is auditable and
   * cannot be spent by any other run. It raises that run's daily and workflow
   * caps by the granted amount rather than disabling the budget: an override
   * is a decision to spend more on this piece of work, not to stop counting.
   *
   * Granting does not restart anything. The run still has to be resumed, so
   * the operator sees what they are about to continue before it spends.
   */
  async overrideRunBudget(
    runId: string,
    microdollars: number,
  ): Promise<RunProjection> {
    if (
      !Number.isSafeInteger(microdollars) ||
      microdollars <= 0 ||
      microdollars > MAX_BUDGET_OVERRIDE_MICRODOLLARS
    )
      throw new ServiceError(
        'invalid_budget_override',
        'a budget override must be a positive amount no larger than $100',
        422,
      );
    const run = await this.repository.getRun(persistenceId('run', runId));
    if (run === undefined)
      throw new ServiceError('not_found', 'run not found', 404);
    const at = this.clock();
    await this.repository.appendEvent({
      runId: run.id,
      eventId: persistenceId('event', `budget-override:${runId}:${String(at)}`),
      fingerprint: fingerprint(`budget-override:${runId}:${String(at)}`),
      type: BUDGET_OVERRIDE_EVENT,
      payload: { microdollars },
      occurredAt: at,
    });
    const refreshed = await this.repository.getRun(run.id);
    return this.project(refreshed ?? run);
  }

  async listTrustedGoalCommands(
    projectId?: string,
  ): Promise<readonly string[]> {
    if (this.trustedGoalCommands === undefined)
      throw new ServiceError(
        'goal_commands_unavailable',
        'the trusted goal command allowlist is not configured',
        503,
      );
    let allowedCommands: ReadonlySet<string> = this.trustedGoalCommands;
    if (projectId !== undefined) {
      const latest = await this.repository.getLatestConfigRevision(
        persistenceId('project', projectId),
      );
      if (latest !== undefined) {
        try {
          const policy = resolveProjectVerificationPolicy(
            parseAgentOsConfig(latest.config),
            {
              trustedTestCommands: this.trustedGoalCommands,
              registryHosts: this.deploymentRegistryHosts,
            },
          );
          allowedCommands = new Set(policy.trustedTestCommands);
        } catch {
          // A project policy can only ever narrow the deployment allowlist,
          // so an unreadable revision falls back to that allowlist rather
          // than failing with a raw parse error. Widening is impossible here.
          allowedCommands = this.trustedGoalCommands;
        }
      }
    }
    return [...allowedCommands].sort();
  }

  async createGoalRun(idempotencyKey: string, input: CreateGoalRunInput) {
    const allowedCommands = new Set(
      await this.listTrustedGoalCommands(input.projectId),
    );
    for (const criterion of input.criteria) {
      if (!allowedCommands.has(criterion.command))
        throw new ServiceError(
          'invalid_goal_criteria',
          'goal criterion commands must name trusted test commands',
          422,
        );
    }
    return this.createRun('goal', idempotencyKey, input);
  }

  /**
   * Resolves a chained run's base into the branch and commit it will build
   * on. Everything here reads the base run's own records: the caller names
   * a run, and the SHA comes from what this system published for it.
   */
  private async resolveChain(
    input: CreateRunInput,
    configRevision: ConfigRevision | undefined,
  ): Promise<RunChain | undefined> {
    const baseRunId = input.baseRunId;
    if (baseRunId === undefined) return undefined;
    const projectId = persistenceId('project', input.projectId);
    const base = await this.repository.getRun(persistenceId('run', baseRunId));
    if (
      base === undefined ||
      base.projectId !== projectId ||
      base.status !== 'succeeded'
    )
      throw new ServiceError(
        'base_run_unavailable',
        'the base run must be a succeeded run in this project',
        422,
      );
    const outcome = record(base.output);
    const baseBranch = outcome?.publishedBranch;
    const baseCommitSha = outcome?.publishedCommitSha;
    if (typeof baseBranch !== 'string' || typeof baseCommitSha !== 'string')
      throw new ServiceError(
        'base_run_unpublished',
        'the base run did not record a published branch and commit to build on',
        422,
      );
    // Both runs must execute under one applied configuration. The caller's
    // provenance already pins the revision; this says the base pinned the
    // same one, so a configuration applied mid-chain ends the chain instead
    // of silently changing what the next run runs under.
    if (configRevision !== undefined) {
      const snapshots = await this.repository.listConfigSnapshots(base.id, {
        limit: 2,
      });
      if (
        snapshots.length !== 1 ||
        snapshots[0]!.configRevisionId !== configRevision.id
      )
        throw new ServiceError(
          'chain_configuration_changed',
          'the base run executed under a different configuration revision',
          409,
        );
    }
    for (const status of ['pending', 'running', 'waiting'] as const) {
      // Per-project concurrency is one, so this page is short by
      // construction; it is bounded anyway rather than trusting that.
      const active = await this.repository.listRuns({
        projectId,
        status,
        limit: ACTIVE_RUN_PAGE,
      });
      if (
        active.some(
          (candidate) =>
            record(record(candidate.input)?.chain)?.baseRunId === baseRunId,
        )
      )
        throw new ServiceError(
          'chained_base_taken',
          'another active run already builds on that base run',
          409,
        );
    }
    const maxDepth = chainDepthLimit(configRevision);
    // Count the runs already in the chain, base included; the run being
    // created is the one after them, so the chain it would produce is
    // `existing + 1`. The walk is bounded by the limit it is checking.
    let existing = 1;
    let ancestor: string | undefined = record(record(base.input)?.chain)
      ?.baseRunId as string | undefined;
    while (typeof ancestor === 'string' && existing <= maxDepth) {
      existing += 1;
      const run = await this.repository.getRun(persistenceId('run', ancestor));
      ancestor = record(record(run?.input)?.chain)?.baseRunId as
        string | undefined;
    }
    if (existing + 1 > maxDepth)
      throw new ServiceError(
        'chain_too_deep',
        `a chain may not exceed ${String(maxDepth)} runs`,
        422,
      );
    return { baseRunId, baseBranch, baseCommitSha };
  }

  async createBacklog(
    idempotencyKey: string,
    input: {
      readonly projectId: string;
      readonly title: string;
      readonly items: readonly {
        readonly title: string;
        readonly description: string;
      }[];
    },
  ): Promise<BacklogProjection> {
    const projectId = persistenceId('project', input.projectId);
    if ((await this.repository.getProject(projectId)) === undefined)
      throw new ServiceError('project_not_found', 'project not found', 404);
    const now = this.clock();
    const id = this.generateId('backlog', `backlog:${idempotencyKey}`);
    const existing = await this.repository.getBacklog(id);
    const backlog =
      existing ??
      (await this.repository.createBacklog({
        id,
        projectId,
        title: input.title,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }));
    for (const [index, item] of input.items.entries()) {
      const ordinal = index + 1;
      await this.repository.createBacklogItemIdempotently({
        id: this.generateId('backlogItem', `${id}:item:${String(ordinal)}`),
        backlogId: backlog.id,
        ordinal,
        title: item.title,
        description: item.description,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }
    return this.backlogProjection(backlog);
  }

  async listBacklogs(projectId: string): Promise<readonly BacklogProjection[]> {
    const backlogs = await this.repository.listBacklogs(
      persistenceId('project', projectId),
      { limit: 100 },
    );
    return mapWithConcurrency(backlogs, DIGEST_QUERY_CONCURRENCY, (backlog) =>
      this.backlogProjection(backlog),
    );
  }

  async setBacklogStatus(
    id: string,
    status: 'active' | 'paused',
  ): Promise<BacklogProjection> {
    const updated = await this.repository.updateBacklogStatus({
      id: persistenceId('backlog', id),
      // Resuming a completed backlog would re-open work that is done, so
      // only the other state is a legal source for each move.
      expected: status === 'active' ? ['paused'] : ['active'],
      status,
      updatedAt: this.clock(),
    });
    if (updated === undefined)
      throw new ServiceError(
        'backlog_state_conflict',
        `backlog is not in a state that can become ${status}`,
        409,
      );
    return this.backlogProjection(updated);
  }

  /**
   * Removing a backlog created by mistake. Refused once any item has
   * produced a run: those runs happened, and a list that can erase its own
   * history is not a record of what was done.
   */
  async deleteBacklog(id: string): Promise<void> {
    const deleted = await this.repository.deleteBacklog(
      persistenceId('backlog', id),
    );
    if (!deleted)
      throw new ServiceError(
        'backlog_not_deletable',
        'a backlog that has started work cannot be deleted; pause it instead',
        409,
      );
  }

  private async backlogProjection(
    backlog: Backlog,
  ): Promise<BacklogProjection> {
    const items = await this.repository.listBacklogItems(backlog.id, {
      limit: 100,
    });
    return {
      id: backlog.id,
      projectId: backlog.projectId,
      title: redactText(backlog.title).slice(0, 200),
      status: backlog.status,
      ...(backlog.pausedReason === undefined
        ? {}
        : { pausedReason: backlog.pausedReason }),
      items: items.map((item) => ({
        id: item.id,
        ordinal: item.ordinal,
        title: redactText(item.title).slice(0, 200),
        status: item.status,
        ...(item.runId === undefined ? {} : { runId: item.runId }),
      })),
      createdAt: backlog.createdAt,
      updatedAt: backlog.updatedAt,
    };
  }

  /**
   * Runs the advance decision for every backlog in a project and acts on it.
   * Called from reconciliation, so it must be safe to run repeatedly and
   * concurrently: the dispatch key is deterministic and the attach is a CAS,
   * so a second pass over the same state creates nothing.
   */
  async advanceBacklogs(projectId: string): Promise<void> {
    const backlogs = await this.repository.listBacklogs(
      persistenceId('project', projectId),
      { limit: 100 },
    );
    for (const backlog of backlogs) {
      if (backlog.status !== 'active') continue;
      const items = await this.repository.listBacklogItems(backlog.id, {
        limit: 100,
      });
      const runs = new Map<string, BacklogItemRun>();
      for (const item of items) {
        if (item.runId === undefined) continue;
        const run = await this.repository.getRun(
          persistenceId('run', item.runId),
        );
        if (run === undefined) continue;
        const outcome = record(run.output);
        const publishedBranch = outcome?.publishedBranch;
        const publishedCommitSha = outcome?.publishedCommitSha;
        runs.set(item.runId, {
          runId: item.runId,
          status: run.status,
          ...(typeof publishedBranch === 'string' ? { publishedBranch } : {}),
          ...(typeof publishedCommitSha === 'string'
            ? { publishedCommitSha }
            : {}),
        });
      }
      await this.settleBacklogItems(items, runs);
      const settled = await this.repository.listBacklogItems(backlog.id, {
        limit: 100,
      });
      const decision = advanceBacklog(backlog, settled, runs);
      if (decision.kind === 'idle') continue;
      if (decision.kind === 'complete') {
        await this.repository.updateBacklogStatus({
          id: backlog.id,
          expected: ['active'],
          status: 'completed',
          updatedAt: this.clock(),
        });
        continue;
      }
      if (decision.kind === 'pause') {
        await this.pauseBacklog(backlog.id, decision.reason);
        continue;
      }
      await this.dispatchBacklogItem(
        backlog,
        decision.item,
        decision.baseRunId,
      );
    }
  }

  private async pauseBacklog(id: BacklogId, reason: string): Promise<void> {
    await this.repository.updateBacklogStatus({
      id,
      expected: ['active'],
      status: 'paused',
      pausedReason: reason,
      updatedAt: this.clock(),
    });
  }

  /** Mirrors a terminal run onto the item that produced it. */
  private async settleBacklogItems(
    items: readonly BacklogItem[],
    runs: ReadonlyMap<string, BacklogItemRun>,
  ): Promise<void> {
    for (const item of items) {
      if (item.runId === undefined || item.status !== 'running') continue;
      const run = runs.get(item.runId);
      if (run === undefined) continue;
      if (run.status === 'succeeded' || run.status === 'failed')
        await this.repository.updateBacklogItem({
          id: item.id,
          expected: ['running'],
          status: run.status,
          updatedAt: this.clock(),
        });
      else if (run.status === 'cancelled')
        await this.repository.updateBacklogItem({
          id: item.id,
          expected: ['running'],
          status: 'failed',
          updatedAt: this.clock(),
        });
    }
  }

  private async dispatchBacklogItem(
    backlog: Backlog,
    item: BacklogItem,
    baseRunId: string | undefined,
  ): Promise<void> {
    const revision = await this.repository.getLatestConfigRevision(
      backlog.projectId,
    );
    if (revision === undefined) {
      await this.pauseBacklog(backlog.id, 'project_unconfigured');
      return;
    }
    try {
      const run = await this.createFeatureRun(
        `backlog:${backlog.id}:item:${String(item.ordinal)}`,
        {
          projectId: backlog.projectId,
          title: item.title,
          description: item.description,
          repositorySha: revision.repositorySha,
          configDigest: revision.configDigest,
          modelDigest: revision.modelDigest,
          promptDigest: revision.promptDigest,
          environmentDigest: revision.environmentDigest,
          policyDigest: revision.policyDigest,
          ...(baseRunId === undefined ? {} : { baseRunId }),
        },
      );
      const attached = await this.repository.updateBacklogItem({
        id: item.id,
        expected: ['pending'],
        status: 'running',
        runId: run.id,
        updatedAt: this.clock(),
      });
      // Another pass won the attach: it owns the run, and this one stops
      // rather than pausing a backlog that is proceeding normally.
      if (attached === undefined) return;
    } catch (error) {
      // Creation refusals are the operator's business -- a chain that went
      // stale, a configuration applied mid-backlog, a project that vanished.
      // The code is the reason, and the backlog stops on it.
      await this.pauseBacklog(
        backlog.id,
        error instanceof ServiceError ? error.code : 'dispatch_failed',
      );
    }
  }

  private async createRun(
    pipeline: 'feature' | 'goal',
    idempotencyKey: string,
    input: CreateRunInput | CreateGoalRunInput,
  ): Promise<RunProjection> {
    const id = this.generateId('run', `${pipeline}:${idempotencyKey}`);
    const requestInput = JSON.parse(canonicalJsonValue(input)) as
      CreateRunInput | CreateGoalRunInput;
    const now = this.clock();
    const projectRecord = await this.repository.getProject(
      persistenceId('project', requestInput.projectId),
    );
    if (projectRecord === undefined)
      throw new ServiceError('project_not_found', 'project not found', 404);
    let configRevision: ConfigRevision | undefined;
    if (
      pipeline === 'goal' ||
      (pipeline === 'feature' && this.workflowDispatch !== undefined)
    ) {
      let after: number | undefined;
      while (configRevision === undefined) {
        const revisions = await this.repository.listConfigRevisions(
          persistenceId('project', requestInput.projectId),
          { ...(after === undefined ? {} : { after }), limit: 100 },
        );
        configRevision = revisions.find(
          (candidate) =>
            candidate.configDigest === requestInput.configDigest &&
            candidate.modelDigest === requestInput.modelDigest &&
            candidate.promptDigest === requestInput.promptDigest &&
            candidate.environmentDigest === requestInput.environmentDigest &&
            candidate.policyDigest === requestInput.policyDigest &&
            candidate.repositorySha === requestInput.repositorySha,
        );
        const last = revisions.at(-1);
        if (configRevision !== undefined || last === undefined) break;
        after = last.revision;
      }
      if (configRevision === undefined)
        throw new ServiceError(
          'config_snapshot_required',
          `${pipeline} provenance does not match an applied configuration revision`,
          409,
        );
    }
    const chain = await this.resolveChain(requestInput, configRevision);
    const runInput = inputForRun(idempotencyKey, requestInput, chain);
    try {
      const created = await this.repository.createRunIdempotently(
        {
          id,
          projectId: persistenceId('project', requestInput.projectId),
          pipeline,
          ...(configRevision === undefined
            ? {}
            : { configRevisionId: configRevision.id }),
          status: 'pending',
          input: runInput,
          createdAt: now,
          updatedAt: now,
        },
        fingerprint({
          pipeline,
          projectId: requestInput.projectId,
          input: runInput,
        }),
      );
      if (configRevision !== undefined) {
        const snapshots = await this.repository.listConfigSnapshots(
          created.id,
          {
            limit: 2,
          },
        );
        if (snapshots.length === 0) {
          await this.repository.createConfigSnapshot({
            id: this.generateId('configSnapshot', `${pipeline}:${created.id}`),
            runId: created.id,
            configRevisionId: configRevision.id,
            config: configRevision.config,
            configDigest: configRevision.configDigest,
            modelDigest: configRevision.modelDigest,
            promptDigest: configRevision.promptDigest,
            environmentDigest: configRevision.environmentDigest,
            policyDigest: configRevision.policyDigest,
            repositorySha: configRevision.repositorySha,
            createdAt: now,
          });
        } else if (
          snapshots.length !== 1 ||
          snapshots[0]!.configRevisionId !== configRevision.id
        ) {
          throw new ServiceError(
            'config_snapshot_conflict',
            `${pipeline} run config snapshot conflicts with its provenance`,
            409,
          );
        }
      }
      if (pipeline === 'goal') {
        const goalInput = requestInput as CreateGoalRunInput;
        const definitions = goalDefinitions(goalInput.criteria);
        for (const [ordinal, definition] of definitions.entries()) {
          const source = goalInput.criteria[ordinal]!;
          await this.repository.createGoalCriterionIdempotently({
            id: deterministicGoalCriterionId(created.id, ordinal),
            runId: created.id,
            ordinal,
            description: source.description,
            definition,
            status: 'pending',
            createdAt: now,
          });
        }
        const persisted = await this.repository.listGoalCriteria(created.id, {
          limit: 21,
        });
        if (persisted.length !== definitions.length)
          throw new ServiceError(
            'goal_criteria_conflict',
            'goal run criteria conflict with its immutable definition',
            409,
          );
      }
      if (pipeline === 'feature' || pipeline === 'goal') {
        try {
          await this.workflowDispatch?.requestStart({
            idempotencyKey: `workflow-start:${created.id}`,
            runId: created.id,
            pipeline,
          });
        } catch {
          // The pending run is the durable outbox intent; reconciliation retries it.
        }
      }
      return this.project(created);
    } catch (error) {
      if (error instanceof Error && error.name === 'IdempotencyConflictError') {
        throw new ServiceError('idempotency_conflict', error.message, 409);
      }
      throw error;
    }
  }

  async listRuns(
    limit = 50,
    projectId?: string,
  ): Promise<readonly RunProjection[]> {
    // Newest first: run listings serve the UI and the CLI, where the latest
    // activity matters most. Reconciliation paginates the repository
    // directly with the ascending cursor order and is unaffected.
    const runs = await this.repository.listRuns({
      limit,
      order: 'desc',
      ...(projectId === undefined
        ? {}
        : { projectId: persistenceId('project', projectId) }),
    });
    // project() issues three to four queries per run, so an unbounded
    // Promise.all here multiplies straight past the Neon HTTP connection
    // ceiling — the same failure the inbox digest was bounded to avoid.
    return mapWithConcurrency(runs, DIGEST_QUERY_CONCURRENCY, (run) =>
      this.project(run),
    );
  }

  async getRun(id: string): Promise<RunProjection> {
    const run = await this.repository.getRun(persistenceId('run', id));
    if (!run) throw new ServiceError('not_found', 'run not found', 404);
    return this.project(run);
  }

  async cancelRun(id: string, idempotencyKey: string): Promise<RunProjection> {
    const runId = persistenceId('run', id);
    const run = await this.repository.getRun(runId);
    if (!run) throw new ServiceError('not_found', 'run not found', 404);
    if (['succeeded', 'failed'].includes(run.status)) {
      throw new ServiceError(
        'invalid_state',
        'completed run cannot be cancelled',
        409,
      );
    }
    if (run.status === 'cancelled') return this.getRun(id);
    const now = this.clock();
    try {
      await this.repository.cancelRunWithEvent(
        runId,
        {
          status: 'cancelled',
          updatedAt: now,
          completedAt: now,
        },
        this.eventDraft(runId, idempotencyKey, 'run.cancelled', {}, now),
      );
    } catch (error) {
      this.rethrowEventConflict(error);
    }
    try {
      await this.workflowDispatch?.requestCancel?.({
        idempotencyKey: `workflow-cancel:${runId}`,
        runId,
      });
    } catch {
      // The atomic run.cancelled event is the durable outbox intent.
    }
    return this.getRun(id);
  }

  async createApproval(
    idempotencyKey: string,
    input: { runId: string; scope: string; expiresAt: IsoTimestamp },
  ): Promise<ApprovalProjection> {
    const approval: Approval = {
      id: this.generateId('approval', `approval:${idempotencyKey}`),
      runId: persistenceId('run', input.runId),
      scope: input.scope,
      fingerprint: fingerprint({ runId: input.runId, scope: input.scope }),
      status: 'pending',
      createdAt: this.clock(),
      expiresAt: input.expiresAt,
    };
    const existing = await this.repository.getApproval(approval.id);
    if (existing) {
      if (
        existing.runId !== approval.runId ||
        existing.scope !== approval.scope ||
        existing.fingerprint !== approval.fingerprint ||
        existing.expiresAt !== approval.expiresAt
      ) {
        throw new ServiceError(
          'idempotency_conflict',
          'approval key conflict',
          409,
        );
      }
      return projectApproval(existing, this.clock());
    }
    return projectApproval(
      await this.repository.createApproval(approval),
      this.clock(),
    );
  }

  private async getApprovalRecord(id: string): Promise<Approval> {
    const approval = await this.repository.getApproval(
      persistenceId('approval', id),
    );
    if (!approval)
      throw new ServiceError('not_found', 'approval not found', 404);
    return approval;
  }

  async consumeApproval(
    id: string,
    decision: 'approve' | 'reject',
    idempotencyKey: string,
    expectedScopeHash?: string,
  ): Promise<ApprovalProjection> {
    const approval = await this.getApprovalRecord(id);
    if (
      expectedScopeHash !== undefined &&
      expectedScopeHash !== approval.fingerprint
    ) {
      throw new ServiceError(
        'approval_scope_mismatch',
        'approval scope hash does not match',
        409,
      );
    }
    const consumedAt = this.clock();
    // The stored status is only half the test: the SQL guard also refuses a
    // decision once expires_at has passed. Checking the column alone let an
    // expired-but-not-yet-swept approval reach that guard, fail there, and
    // surface as the meaningless 'approval is invalid' instead of saying it
    // ran out of time.
    if (
      approval.status === 'expired' ||
      Date.parse(approval.expiresAt) <= Date.parse(consumedAt)
    ) {
      throw new ServiceError(
        'approval_expired',
        'approval expired before a decision was recorded',
        409,
      );
    }
    const decisionType =
      decision === 'approve' ? 'approval.approved' : 'approval.rejected';
    let consumed: Approval | undefined;
    try {
      consumed = await this.repository.consumeApprovalWithEvent(
        {
          approvalId: approval.id,
          runId: approval.runId,
          scope: approval.scope,
          fingerprint: approval.fingerprint,
          consumedAt,
        },
        this.eventDraft(
          approval.runId,
          `approval:${idempotencyKey}`,
          decisionType,
          { approvalId: id, scopeHash: approval.fingerprint },
          consumedAt,
        ),
      );
    } catch (error) {
      this.rethrowEventConflict(error);
    }
    if (!consumed)
      throw new ServiceError(
        approval.status === 'consumed'
          ? 'approval_already_decided'
          : 'approval_invalid',
        approval.status === 'consumed'
          ? 'approval was already decided'
          : 'approval is invalid',
        409,
      );
    try {
      await this.workflowDispatch?.requestApprovalResume({
        idempotencyKey: `workflow-resume:${consumed.id}:${decision}`,
        runId: consumed.runId,
        approvalId: consumed.id,
        decision,
        scopeHash: consumed.fingerprint,
      });
    } catch {
      // The atomic approval event is the durable outbox intent.
    }
    return projectApproval(consumed, consumedAt);
  }

  async listInbox(
    limit = 50,
    projectId?: string,
  ): Promise<readonly InboxProjection[]> {
    const runs = await this.repository.listRuns({
      limit,
      ...(projectId === undefined
        ? {}
        : { projectId: persistenceId('project', projectId) }),
    });
    const pages = await mapWithConcurrency(
      runs,
      DIGEST_QUERY_CONCURRENCY,
      (run) => this.repository.listInboxMessages(run.id, undefined, { limit }),
    );
    return pages
      .flat()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(projectInboxMessage);
  }

  /** Exact attention total; every underlying repository list is page-capped. */
  async countInboxAttention(): Promise<number> {
    const now = this.clock();
    let after: TimestampListCursor<WorkflowRun['id']> | undefined;
    let count = 0;
    while (true) {
      const runs = await this.repository.listRuns({
        limit: ATTENTION_COUNT_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      const perRun = await mapWithConcurrency(
        runs,
        DIGEST_QUERY_CONCURRENCY,
        async (run) => {
          const [messages, approvals] = await Promise.all([
            countTimestampedPages<InboxMessage>((messageAfter) =>
              this.repository.listInboxMessages(run.id, 'pending', {
                limit: ATTENTION_COUNT_PAGE,
                ...(messageAfter === undefined ? {} : { after: messageAfter }),
              }),
            ),
            countTimestampedPages<Approval>(
              (approvalAfter) =>
                this.repository.listApprovals(run.id, {
                  status: 'pending',
                  limit: ATTENTION_COUNT_PAGE,
                  ...(approvalAfter === undefined
                    ? {}
                    : { after: approvalAfter }),
                }),
              (approval) => projectApproval(approval, now).status === 'pending',
            ),
          ]);
          return messages + approvals;
        },
      );
      count += perRun.reduce((total, runCount) => total + runCount, 0);
      if (runs.length < ATTENTION_COUNT_PAGE) return count;
      const last = runs[runs.length - 1]!;
      after = { at: last.createdAt, id: last.id };
    }
  }

  /**
   * Everything the inbox page renders, from a single run listing: approvals
   * of every status (resolved ones keep their decision so the inbox is a
   * permanent record, not a queue that swallows history), question threads,
   * and system notifications synthesized from terminal run rows. Synthesis
   * beats durable emission here: it needs no migration or worker change and
   * covers every run that ever finished, not just future ones.
   */
  async inboxDigest(
    limit = 50,
    projectId?: string,
    includeRunId?: string,
  ): Promise<InboxDigest> {
    const now = this.clock();
    const listedRuns = await this.repository.listRuns({
      limit,
      order: 'desc',
      ...(projectId === undefined
        ? {}
        : { projectId: persistenceId('project', projectId) }),
    });
    const includedRun =
      includeRunId === undefined
        ? undefined
        : await this.repository
            .getRun(persistenceId('run', includeRunId))
            .catch(() => undefined);
    const runs =
      includedRun === undefined ||
      listedRuns.some((run) => run.id === includedRun.id) ||
      (projectId !== undefined &&
        includedRun.projectId !== persistenceId('project', projectId))
        ? listedRuns
        : [...listedRuns, includedRun];
    const pages = await mapWithConcurrency(
      runs,
      DIGEST_QUERY_CONCURRENCY,
      async (run) => {
        const [messages, approvals] = await Promise.all([
          this.repository.listInboxMessages(run.id, undefined, { limit }),
          this.repository.listApprovals(run.id, { limit }),
        ]);
        return { approvals, messages, run };
      },
    );

    const projectNames = new Map<string, string>();
    await mapWithConcurrency(
      [...new Set(runs.map((run) => run.projectId))],
      DIGEST_QUERY_CONCURRENCY,
      async (projectId) => {
        try {
          const project = await this.repository.getProject(projectId);
          if (project !== undefined)
            projectNames.set(projectId, redactText(project.name).slice(0, 120));
        } catch {
          // Attribution is decoration; it is never worth an inbox error.
        }
      },
    );

    const terminal = pages.filter(({ run }) =>
      TERMINAL_RUN_STATUSES.has(run.status),
    );
    const spendByRun = new Map<string, number>();
    await mapWithConcurrency(
      terminal.slice(0, NOTIFICATION_SPEND_LOOKUPS),
      DIGEST_QUERY_CONCURRENCY,
      async ({ run }) => {
        const usage = await this.repository
          .listUsage(run.id, { limit: 1_000 })
          .catch(() => []);
        if (usage.length > 0)
          spendByRun.set(
            run.id,
            usage.reduce((total, entry) => total + entry.microdollars, 0),
          );
      },
    );

    const approvals = await mapWithConcurrency(
      pages.flatMap(({ approvals: records, run }) =>
        records.map((approval) => ({ approval, run })),
      ),
      DIGEST_QUERY_CONCURRENCY,
      async ({ approval, run }): Promise<InboxApprovalItem> => {
        const projected = projectApproval(approval, now);
        const projectName = projectNames.get(run.projectId);
        const base =
          projectName === undefined ? projected : { ...projected, projectName };
        if (projected.status === 'consumed') {
          const rejected =
            safeString(record(run.output), 'status') === 'rejected';
          return {
            ...base,
            ...(await this.approvalSummary(projected)),
            decision: rejected ? 'rejected' : 'approved',
          };
        }
        // Expired approvals cannot be acted on, so they alone skip the artifact
        // reads. Consumed approvals keep the reviewed scope as durable history.
        if (projected.status === 'pending')
          return { ...base, ...(await this.approvalSummary(projected)) };
        return base;
      },
    );

    const notifications = terminal.map(({ run }): RunNotificationProjection => {
      const output = record(run.output);
      const title = projectRunInput(run.input)?.title;
      const resultStatus = safeString(output, 'status');
      const reason = safeString(output, 'reason')?.slice(0, 240);
      const outcome = projectRunOutcome(run.output);
      const spend = spendByRun.get(run.id);
      const projectName = projectNames.get(run.projectId);
      return {
        runId: run.id,
        pipeline: run.pipeline,
        runStatus: run.status as RunNotificationProjection['runStatus'],
        completedAt: run.completedAt ?? run.updatedAt,
        ...(title === undefined ? {} : { title }),
        ...(resultStatus === undefined ? {} : { resultStatus }),
        ...(reason === undefined ? {} : { reason }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(spend === undefined ? {} : { totalCostUsd: spend / 1_000_000 }),
        ...(projectName === undefined ? {} : { projectName }),
      };
    });

    const byNewest = (a: { createdAt: string }, b: { createdAt: string }) =>
      b.createdAt.localeCompare(a.createdAt);
    return {
      approvals: [...approvals].sort(byNewest),
      messages: pages
        .flatMap(({ messages }) => messages)
        .sort(byNewest)
        .map((message) => {
          const projected = projectInboxMessage(message);
          const run = runs.find((candidate) => candidate.id === message.runId);
          const projectName =
            run === undefined ? undefined : projectNames.get(run.projectId);
          return projectName === undefined
            ? projected
            : { ...projected, projectName };
        }),
      notifications: [...notifications].sort((a, b) =>
        b.completedAt.localeCompare(a.completedAt),
      ),
    };
  }

  async listPendingApprovals(
    limit = 50,
    includeSummaries = true,
    projectId?: string,
  ): Promise<readonly ApprovalProjection[]> {
    const runs = await this.repository.listRuns({
      limit,
      ...(projectId === undefined
        ? {}
        : { projectId: persistenceId('project', projectId) }),
    });
    const pages = await mapWithConcurrency(
      runs,
      DIGEST_QUERY_CONCURRENCY,
      (run) =>
        this.repository.listApprovals(run.id, { status: 'pending', limit }),
    );
    const now = this.clock();
    // "Pending" has to mean actionable. The repository filters on the stored
    // status, which stays 'pending' past the deadline until reconciliation
    // rewrites it, so drop the ones the clock has already settled -- both the
    // attention badge and the inbox list read this.
    const projected = pages
      .flat()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((approval) => projectApproval(approval, now))
      .filter((approval) => approval.status === 'pending');
    if (!includeSummaries) return projected;
    return mapWithConcurrency(
      projected,
      DIGEST_QUERY_CONCURRENCY,
      async (approval) => ({
        ...approval,
        ...(await this.approvalSummary(approval)),
      }),
    );
  }

  /**
   * Lightweight status count for navigation badges: one repository query,
   * no per-run projection (a full projection costs four queries per run).
   */
  async countRunsByStatus(status: RunStatus): Promise<number> {
    return this.repository.countRuns({ status });
  }

  /**
   * The acceptance criteria the specifier froze for a run: one per
   * requirement, each already exercised by a sealed acceptance test. For an
   * operator about to look at the delivered code, this is the smoke test,
   * written before the implementation existed. Fail-soft like every other
   * artifact read here.
   */
  async doneCriteria(
    runId: string,
  ): Promise<readonly { readonly id: string; readonly description: string }[]> {
    if (this.artifacts === undefined) return [];
    try {
      const run = await this.repository.getRun(persistenceId('run', runId));
      if (run === undefined) return [];
      const scope = {
        projectId: run.projectId,
        runId: run.id,
        stepId: 'specification',
      };
      const page = await this.artifacts.list({ scope, limit: 10 });
      const item = page.items.find(
        (candidate) => candidate.artifactId === 'dod',
      );
      if (item === undefined) return [];
      const value = await this.artifacts.get({
        scope,
        key: item.key,
        maxBytes: 1_000_000,
      });
      if (value === undefined) return [];
      const body = record(
        JSON.parse(new TextDecoder().decode(value.bytes)) as JsonValue,
      );
      const criteria = body?.criteria;
      if (!Array.isArray(criteria)) return [];
      return criteria.slice(0, 20).flatMap((entry) => {
        const candidate = record(entry);
        const id = safeString(candidate, 'id');
        const description = safeString(candidate, 'description');
        return id !== undefined && description !== undefined
          ? [{ id, description: description.slice(0, 500) }]
          : [];
      });
    } catch {
      return [];
    }
  }

  /**
   * What the reviewer said, for a run that review stopped.
   *
   * "final review after fix must be approved" is a true sentence and a dead
   * end: it names the gate without naming the objection, so the one thing the
   * operator needs in order to act is the one thing the page does not show.
   * The findings live in the review artifact, so read them.
   *
   * Fail-soft like every other artifact read here: an unreadable review
   * degrades to the bare failure reason, never to an error page.
   */
  async reviewOutcome(runId: string): Promise<ReviewOutcome | undefined> {
    if (this.artifacts === undefined) return undefined;
    try {
      const run = await this.repository.getRun(persistenceId('run', runId));
      if (run === undefined) return undefined;
      // The last word wins: a run that was fixed and re-reviewed is explained
      // by the re-review, not by the objection that triggered the fix.
      for (const stepId of ['review-after-fix', 'review']) {
        const scope = { projectId: run.projectId, runId: run.id, stepId };
        const page = await this.artifacts.list({ scope, limit: 10 });
        const item = page.items.find(
          (candidate) => candidate.artifactId === 'review',
        );
        if (item === undefined) continue;
        const value = await this.artifacts.get({
          scope,
          key: item.key,
          maxBytes: 1_000_000,
        });
        if (value === undefined) continue;
        const body = record(
          JSON.parse(new TextDecoder().decode(value.bytes)) as JsonValue,
        );
        if (body?.version !== 'review-result-v1') continue;
        const decision = safeString(body, 'decision');
        const rawFindings = body.findings;
        const findings = Array.isArray(rawFindings)
          ? rawFindings
              .slice(0, 20)
              .map((entry: unknown) =>
                typeof entry === 'string'
                  ? redactText(entry).slice(0, 1_000)
                  : undefined,
              )
              .filter((entry): entry is string => entry !== undefined)
          : [];
        if (decision === undefined) continue;
        return { stepId, decision, findings };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Human-readable context for a spec/DoD approval: the feature title plus
   * the specification requirements and Definition of Done criteria the
   * agent stored as artifacts. Fail-soft by design — an unreadable artifact
   * degrades to the bare approval, never to an inbox error.
   */
  private async approvalSummary(
    approval: ApprovalProjection,
  ): Promise<{ summary?: ApprovalSummary }> {
    if (
      this.artifacts === undefined ||
      approval.scopePreview !== 'feature-spec-and-dod'
    )
      return {};
    try {
      const run = await this.repository.getRun(
        persistenceId('run', approval.runId),
      );
      if (run === undefined) return {};
      const title = safeString(record(run.input), 'title');
      const scope = {
        projectId: run.projectId,
        runId: run.id,
        stepId: 'specification',
      };
      const page = await this.artifacts.list({ scope, limit: 10 });
      const bodyOf = async (artifactId: string): Promise<unknown> => {
        const item = page.items.find(
          (candidate) => candidate.artifactId === artifactId,
        );
        if (item === undefined) return undefined;
        const value = await this.artifacts!.get({
          scope,
          key: item.key,
          maxBytes: 1_000_000,
        });
        if (value === undefined) return undefined;
        return JSON.parse(new TextDecoder().decode(value.bytes));
      };
      const bounded = (value: unknown): string | undefined =>
        typeof value === 'string' ? redactText(value).slice(0, 500) : undefined;
      const specification = (await bodyOf('specification')) as
        { requirements?: unknown } | undefined;
      const dod = (await bodyOf('dod')) as
        { criteria?: unknown; acceptanceTests?: unknown } | undefined;
      const requirements = Array.isArray(specification?.requirements)
        ? specification.requirements
            .slice(0, 20)
            .map(bounded)
            .filter((entry): entry is string => entry !== undefined)
        : undefined;
      const criteria = Array.isArray(dod?.criteria)
        ? dod.criteria.slice(0, 20).flatMap((entry: unknown) => {
            if (entry === null || typeof entry !== 'object') return [];
            const candidate = entry as { id?: unknown; description?: unknown };
            const id = bounded(candidate.id);
            const description = bounded(candidate.description);
            return id !== undefined && description !== undefined
              ? [{ id, description }]
              : [];
          })
        : undefined;

      const ACC_BOUND = 8_000;
      const acceptanceTests = Array.isArray(dod?.acceptanceTests)
        ? dod.acceptanceTests.slice(0, 20).flatMap((entry) => {
            if (entry === null || typeof entry !== 'object') return [];
            const candidate = entry as { path?: unknown; content?: unknown };
            const path = bounded(candidate.path);
            if (typeof candidate.content !== 'string' || path === undefined)
              return [];
            const content = redactText(candidate.content).slice(0, ACC_BOUND);
            return [{ path, content }];
          })
        : undefined;

      if (
        title === undefined &&
        requirements === undefined &&
        criteria === undefined &&
        (acceptanceTests === undefined || acceptanceTests.length === 0)
      )
        return {};
      return {
        summary: {
          ...(title === undefined ? {} : { title }),
          ...(requirements === undefined || requirements.length === 0
            ? {}
            : { requirements }),
          ...(criteria === undefined || criteria.length === 0
            ? {}
            : { criteria }),
          ...(acceptanceTests === undefined || acceptanceTests.length === 0
            ? {}
            : { acceptanceTests }),
        },
      };
    } catch {
      return {};
    }
  }

  async replyInbox(
    id: string,
    reply: JsonValue,
    idempotencyKey: string,
  ): Promise<InboxProjection> {
    const message = await this.repository.getInboxMessage(
      persistenceId('inboxMessage', id),
    );
    if (!message)
      throw new ServiceError('not_found', 'inbox item not found', 404);
    if (message.status === 'replied') {
      const eventId = this.generateId(
        'event',
        `event:${message.runId}:inbox:${idempotencyKey}`,
      );
      const existing = await this.repository.getEvent(message.runId, eventId);
      if (
        !existing ||
        canonicalJsonValue(message.reply) !== canonicalJsonValue(reply)
      ) {
        throw new ServiceError(
          'idempotency_conflict',
          'reply key conflict',
          409,
        );
      }
      return projectInboxMessage(message);
    }
    const repliedAt = this.clock();
    let result: InboxMessage;
    try {
      result = await this.repository.replyInboxMessageWithEvent(
        { messageId: message.id, reply, repliedAt },
        this.eventDraft(
          message.runId,
          `inbox:${idempotencyKey}`,
          'inbox.replied',
          { messageId: id, replyFingerprint: fingerprint(reply) },
          repliedAt,
        ),
      );
    } catch (error) {
      this.rethrowEventConflict(error);
    }
    return projectInboxMessage(result);
  }

  async appendEvent(
    runIdValue: string,
    idempotencyKey: string,
    type: string,
    payload: JsonValue,
  ): Promise<DomainEvent> {
    const runId = persistenceId('run', runIdValue);
    try {
      return await this.repository.appendEvent(
        this.eventDraft(runId, idempotencyKey, type, payload, this.clock()),
      );
    } catch (error) {
      this.rethrowEventConflict(error);
    }
  }

  private eventDraft(
    runId: WorkflowRun['id'],
    idempotencyKey: string,
    type: string,
    payload: JsonValue,
    occurredAt: IsoTimestamp,
  ): DomainEventDraft {
    return {
      runId,
      eventId: this.generateId('event', `event:${runId}:${idempotencyKey}`),
      fingerprint: fingerprint({ type, payload }),
      type,
      payload,
      occurredAt,
    };
  }

  private rethrowEventConflict(error: unknown): never {
    if (
      error instanceof Error &&
      error.name === 'EventFingerprintConflictError'
    ) {
      throw new ServiceError(
        'idempotency_conflict',
        'idempotency key was already used with another payload',
        409,
      );
    }
    throw error;
  }

  private async project(run: WorkflowRun): Promise<RunProjection> {
    const [steps, events, goal, usage] = await Promise.all([
      this.repository.listStepRuns(run.id, { limit: 100 }),
      this.repository.listEvents(run.id, { limit: 1_000 }),
      this.projectGoal(run),
      // Per-step model info is decorative; a failed usage lookup (e.g. a
      // transient database hiccup) must never take a page down with it.
      this.repository.listUsage(run.id, { limit: 1_000 }).catch(() => []),
    ]);
    // Usage records carry the model that actually executed each step (the
    // provider-reported identity), which is stronger evidence than the
    // configured model profile.
    const stepModels = new Map<string, string>();
    for (const entry of usage) {
      if (entry.stepRunId !== undefined && !stepModels.has(entry.stepRunId))
        stepModels.set(entry.stepRunId, redactText(entry.model).slice(0, 120));
    }
    const progressByStep = new Map<
      string,
      ReturnType<typeof projectStepProgress>[]
    >();
    for (const event of events) {
      const progress = projectStepProgress(event);
      if (progress === undefined) continue;
      const entries = progressByStep.get(progress.stepRunId) ?? [];
      entries.push(progress);
      progressByStep.set(progress.stepRunId, entries);
    }
    const safeInput = projectRunInput(run.input);
    const safeError = projectRunError(run.error);
    const outcome = projectRunOutcome(run.output);
    const chain = projectRunChain(run.input);
    return {
      id: run.id,
      projectId: run.projectId,
      pipeline: run.pipeline,
      status: run.status,
      ...(safeInput === undefined ? {} : { input: safeInput }),
      ...(safeError === undefined ? {} : { error: safeError }),
      ...(goal === undefined ? {} : { goal }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(chain === undefined ? {} : { chain }),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...provenance(run),
      steps: steps.map((step) => ({
        id: step.id,
        stepKey: step.stepKey,
        attempt: step.attempt,
        status: step.status,
        ...(stepModels.has(step.id) ? { model: stepModels.get(step.id)! } : {}),
        progress: (progressByStep.get(step.id) ?? [])
          .filter(
            (entry): entry is NonNullable<typeof entry> =>
              entry !== undefined &&
              entry.stepKey === step.stepKey &&
              entry.attempt === step.attempt,
          )
          // Each note is stamped with the provider event's own time, which
          // need not match the order the worker appended them in, so order by
          // the time the operator sees before keeping the newest notes.
          .sort(
            (left, right) =>
              Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
              left.sequence - right.sequence,
          )
          .slice(-100)
          .map(({ eventId, phase, message, occurredAt }) => ({
            eventId,
            phase,
            message,
            occurredAt,
          })),
      })),
      timeline: events
        .filter((event) => event.type !== 'step.progress')
        .map((event) => {
          const payload = projectEventPayload(event.payload);
          return {
            eventId: event.eventId,
            sequence: event.sequence,
            type: event.type,
            ...(payload === undefined ? {} : { payload }),
            occurredAt: event.occurredAt,
          };
        }),
    };
  }

  private async projectGoal(run: WorkflowRun): Promise<RunProjection['goal']> {
    if (run.pipeline !== 'goal') return undefined;
    const [criterionRecords, progress, snapshots] = await Promise.all([
      this.repository.listGoalCriteria(run.id, { limit: 21 }),
      this.repository.listGoalProgress(run.id, { limit: 100 }),
      this.repository.listConfigSnapshots(run.id, { limit: 2 }),
    ]);
    let maxSteps = 3;
    if (snapshots.length === 1) {
      try {
        maxSteps = parseAgentOsConfig(snapshots[0]!.config).goals.maxSteps;
      } catch {
        maxSteps = 3;
      }
    }
    maxSteps = Math.max(1, Math.min(3, maxSteps));
    const criteria = criterionRecords
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal)
      .flatMap((criterion) => {
        const definition = record(criterion.definition);
        const id = definition?.id;
        const description = definition?.description;
        if (typeof id !== 'string' || typeof description !== 'string')
          return [];
        return [
          {
            id: id.slice(0, 128),
            description: redactText(description).slice(0, 1_000),
            required: definition?.required !== false,
            recordId: criterion.id,
          },
        ];
      });
    const criterionByRecord = new Map(
      criteria.map((criterion) => [criterion.recordId, criterion]),
    );
    const latest = new Map<
      string,
      NonNullable<RunProjection['goal']>['latestResults'][number]
    >();
    const childCheckpoints = new Map<number, WorkflowRun['id']>();
    let currentStep = 1;
    for (const item of progress) {
      if (
        !Number.isSafeInteger(item.step) ||
        item.step < 1 ||
        item.step > maxSteps
      )
        continue;
      currentStep = Math.max(currentStep, item.step);
      if (item.criterionId === undefined) {
        const payload = record(item.payload);
        const childRunId = payload?.childRunId;
        const expected = persistenceId(
          'run',
          `goal-child-${createHash('sha256')
            .update(`${run.id}\u0000${String(item.step)}`)
            .digest('hex')}`,
        );
        if (
          item.id ===
            persistenceId(
              'goalProgress',
              `goal:${run.id}:step:${String(item.step)}:child`,
            ) &&
          item.status === 'pending' &&
          payload?.version === 'goal-child-attempt-v1' &&
          childRunId === expected
        )
          childCheckpoints.set(item.step, expected);
        continue;
      }
      const criterion = criterionByRecord.get(item.criterionId);
      if (criterion === undefined) continue;
      const payload = record(item.payload);
      const result = record(payload?.result);
      const resultStatus = result?.status;
      if (
        item.id !==
          persistenceId(
            'goalProgress',
            `goal:${run.id}:step:${String(item.step)}:criterion:${criterion.id}`,
          ) ||
        payload?.version !== 'goal-criterion-result-v1' ||
        result?.criterionId !== criterion.id ||
        (resultStatus === 'passed' && item.status !== 'satisfied') ||
        (resultStatus === 'failed' && item.status !== 'failed') ||
        (resultStatus !== 'passed' && resultStatus !== 'failed')
      )
        continue;
      const prior = latest.get(criterion.id);
      if (prior !== undefined && prior.step > item.step) continue;
      const code =
        resultStatus === 'failed' ? safeString(result, 'code') : undefined;
      latest.set(criterion.id, {
        criterionId: criterion.id,
        step: item.step,
        status: resultStatus,
        ...(code === undefined ? {} : { code: code.slice(0, 128) }),
      });
    }
    const children = (
      await Promise.all(
        [...childCheckpoints.entries()]
          .sort(([left], [right]) => left - right)
          .map(async ([step, runId]) => {
            const child = await this.repository.getRun(runId);
            if (
              child === undefined ||
              child.projectId !== run.projectId ||
              child.pipeline !== 'feature'
            )
              return undefined;
            const output = record(child.output);
            const draftPullRequestUrl = safeHttpUrl(
              output,
              'draftPullRequestUrl',
            );
            const localBranch = safeString(output, 'localBranch');
            const localRepositoryUrl = safeString(output, 'localRepositoryUrl');
            return {
              step,
              runId,
              status: child.status,
              ...(draftPullRequestUrl === undefined
                ? {}
                : { draftPullRequestUrl }),
              ...(localBranch === undefined ? {} : { localBranch }),
              ...(localRepositoryUrl === undefined
                ? {}
                : { localRepositoryUrl }),
            };
          }),
      )
    ).filter(
      (child): child is NonNullable<typeof child> => child !== undefined,
    );
    return {
      maxSteps,
      currentStep: Math.min(maxSteps, currentStep),
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        description: criterion.description,
        required: criterion.required,
      })),
      latestResults: criteria.flatMap((criterion) => {
        const result = latest.get(criterion.id);
        return result === undefined ? [] : [result];
      }),
      children,
    };
  }
}
