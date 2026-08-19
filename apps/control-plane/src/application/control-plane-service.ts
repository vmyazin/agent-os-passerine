import { createHash } from 'node:crypto';

import { deterministicGoalCriterionId } from '@agentos/adapters';

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
  RunStatus,
  WorkflowRun,
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
} from '@agentos/core';

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
}

export interface CreateGoalRunInput extends CreateRunInput {
  readonly criteria: readonly CommandCriterion[];
}

/** Durable intents live in the run/approval event rows; this port delivers them. */
export interface WorkflowDispatchOutbox {
  requestStart(request: {
    readonly idempotencyKey: string;
    readonly runId: string;
    readonly pipeline: 'feature' | 'goal';
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
}

export interface ConfigurationProjection {
  readonly canonicalConfig?: string;
  readonly projectId: string;
  readonly digest: string;
  readonly revision: number;
  readonly appliedAt: IsoTimestamp;
  readonly provenance: PersistenceDigests;
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

export interface ApprovalProjection {
  readonly id: string;
  readonly runId: string;
  readonly scopeHash: string;
  readonly scopePreview: string;
  readonly status: Approval['status'];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly consumedAt?: IsoTimestamp;
}

function projectApproval(approval: Approval): ApprovalProjection {
  return {
    id: approval.id,
    runId: approval.runId,
    scopeHash: approval.fingerprint,
    scopePreview: redactText(approval.scope).slice(0, 240),
    status: approval.status,
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

function inputForRun(
  idempotencyKey: string,
  input: CreateRunInput | CreateGoalRunInput,
): JsonValue {
  return {
    idempotencyKey,
    title: input.title,
    description: input.description,
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
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly steps: readonly {
    id: string;
    stepKey: string;
    attempt: number;
    status: string;
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
  ) {}

  async getConfiguration(includeCanonical = true): Promise<{
    readonly active: ConfigurationProjection | null;
  }> {
    const active = await this.repository.getLatestConfigRevision();
    return {
      active:
        active === undefined
          ? null
          : configurationProjection(active, includeCanonical),
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
    const active = await this.repository.getLatestConfigRevision();
    const projectId =
      active?.projectId ?? this.generateId('project', 'configuration');
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

  async createGoalRun(idempotencyKey: string, input: CreateGoalRunInput) {
    if (this.trustedGoalCommands === undefined)
      throw new ServiceError(
        'goal_commands_unavailable',
        'the trusted goal command allowlist is not configured',
        503,
      );
    for (const criterion of input.criteria) {
      if (!this.trustedGoalCommands.has(criterion.command))
        throw new ServiceError(
          'invalid_goal_criteria',
          'goal criterion commands must name trusted test commands',
          422,
        );
    }
    return this.createRun('goal', idempotencyKey, input);
  }

  private async createRun(
    pipeline: 'feature' | 'goal',
    idempotencyKey: string,
    input: CreateRunInput | CreateGoalRunInput,
  ): Promise<RunProjection> {
    const id = this.generateId('run', `${pipeline}:${idempotencyKey}`);
    const requestInput = JSON.parse(canonicalJsonValue(input)) as
      CreateRunInput | CreateGoalRunInput;
    const runInput = inputForRun(idempotencyKey, requestInput);
    const now = this.clock();
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

  async listRuns(limit = 50): Promise<readonly RunProjection[]> {
    // Newest first: run listings serve the UI and the CLI, where the latest
    // activity matters most. Reconciliation paginates the repository
    // directly with the ascending cursor order and is unaffected.
    const runs = await this.repository.listRuns({ limit, order: 'desc' });
    return Promise.all(runs.map((run) => this.project(run)));
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
      return projectApproval(existing);
    }
    return projectApproval(await this.repository.createApproval(approval));
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
    if (approval.status === 'expired') {
      throw new ServiceError('approval_expired', 'approval expired', 409);
    }
    const decisionType =
      decision === 'approve' ? 'approval.approved' : 'approval.rejected';
    const consumedAt = this.clock();
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
    return projectApproval(consumed);
  }

  async listInbox(limit = 50): Promise<readonly InboxProjection[]> {
    const runs = await this.repository.listRuns({ limit });
    const pages = await Promise.all(
      runs.map((run) =>
        this.repository.listInboxMessages(run.id, undefined, { limit }),
      ),
    );
    return pages
      .flat()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(projectInboxMessage);
  }

  async listPendingApprovals(
    limit = 50,
  ): Promise<readonly ApprovalProjection[]> {
    const runs = await this.repository.listRuns({ limit });
    const pages = await Promise.all(
      runs.map((run) =>
        this.repository.listApprovals(run.id, { status: 'pending', limit }),
      ),
    );
    return pages
      .flat()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(projectApproval);
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
    const [steps, events, goal] = await Promise.all([
      this.repository.listStepRuns(run.id, { limit: 100 }),
      this.repository.listEvents(run.id, { limit: 1_000 }),
      this.projectGoal(run),
    ]);
    const safeInput = projectRunInput(run.input);
    const safeError = projectRunError(run.error);
    return {
      id: run.id,
      projectId: run.projectId,
      pipeline: run.pipeline,
      status: run.status,
      ...(safeInput === undefined ? {} : { input: safeInput }),
      ...(safeError === undefined ? {} : { error: safeError }),
      ...(goal === undefined ? {} : { goal }),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...provenance(run),
      steps: steps.map((step) => ({
        id: step.id,
        stepKey: step.stepKey,
        attempt: step.attempt,
        status: step.status,
      })),
      timeline: events.map((event) => {
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
            const candidateUrl = safeString(output, 'draftPullRequestUrl');
            let draftPullRequestUrl: string | undefined;
            if (candidateUrl !== undefined && candidateUrl.length <= 2_048) {
              try {
                const parsed = new URL(candidateUrl);
                if (parsed.protocol === 'https:' || parsed.protocol === 'http:')
                  draftPullRequestUrl = candidateUrl;
              } catch {
                draftPullRequestUrl = undefined;
              }
            }
            return {
              step,
              runId,
              status: child.status,
              ...(draftPullRequestUrl === undefined
                ? {}
                : { draftPullRequestUrl }),
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
