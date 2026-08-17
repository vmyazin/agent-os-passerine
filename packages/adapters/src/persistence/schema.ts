import { isoTimestamp, type IsoTimestamp, type JsonValue } from '@agentos/core';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core';

function normalizeTimestampDriverValue(value: Date | string): IsoTimestamp {
  if (value instanceof Date) return isoTimestamp(value.toISOString());

  const withSeparator = value.replace(' ', 'T');
  const withOffsetMinutes = withSeparator
    .replace(/([+-]\d{2})$/, '$1:00')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const withFraction = withOffsetMinutes.replace(
    /(T\d{2}:\d{2}:\d{2})(?=Z|[+-])/,
    '$1.000000',
  );
  return isoTimestamp(withFraction.replace(/\+00:00$/, 'Z'));
}

const instantType = customType<{
  data: IsoTimestamp;
  driverData: Date | string;
}>({
  dataType: () => 'timestamp with time zone',
  fromDriver: normalizeTimestampDriverValue,
  toDriver: (value) => value,
});
const instant = (name: string) => instantType(name);
const json = (name: string) => jsonb(name).$type<JsonValue>();
const bytewise = (column: AnyPgColumn) => sql`${column} collate "C"`;

export const runStatus = pgEnum('run_status', [
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
]);
export const externalSessionStatus = pgEnum('external_session_status', [
  'active',
  'completed',
  'cancelled',
  'failed',
]);
export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'consumed',
  'expired',
]);
export const inboxStatus = pgEnum('inbox_status', ['pending', 'replied']);
export const goalStatus = pgEnum('goal_status', [
  'pending',
  'satisfied',
  'failed',
]);
export const workflowEffectStatus = pgEnum('workflow_effect_status', [
  'pending',
  'started',
  'succeeded',
  'failed',
  'dead_letter',
]);

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    repository: text('repository'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    index('projects_created_idx').on(table.createdAt, bytewise(table.id)),
  ],
);

export const configRevisions = pgTable(
  'config_revisions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    config: json('config').notNull(),
    configDigest: text('config_digest').notNull(),
    modelDigest: text('model_digest').notNull(),
    promptDigest: text('prompt_digest').notNull(),
    environmentDigest: text('environment_digest').notNull(),
    policyDigest: text('policy_digest').notNull(),
    repositorySha: text('repository_sha').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    unique('config_revisions_project_revision_unique').on(
      table.projectId,
      table.revision,
    ),
    check('config_revisions_revision_positive', sql`${table.revision} > 0`),
    index('config_revisions_project_created_idx').on(
      table.projectId,
      table.createdAt,
      bytewise(table.id),
    ),
  ],
);

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    configRevisionId: text('config_revision_id').references(
      () => configRevisions.id,
      { onDelete: 'restrict' },
    ),
    pipeline: text('pipeline').notNull(),
    idempotencyFingerprint: text('idempotency_fingerprint'),
    status: runStatus('status').notNull(),
    input: json('input'),
    output: json('output'),
    error: json('error'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
    startedAt: instant('started_at'),
    completedAt: instant('completed_at'),
    cleanupAt: instant('cleanup_at'),
    stateVersion: integer('state_version').notNull().default(0),
  },
  (table) => [
    index('workflow_runs_status_idx').on(
      table.projectId,
      table.status,
      table.createdAt,
      bytewise(table.id),
    ),
    index('workflow_runs_cleanup_idx')
      .on(table.cleanupAt)
      .where(sql`${table.cleanupAt} is not null`),
    index('workflow_runs_created_idx').on(table.createdAt, bytewise(table.id)),
    index('workflow_runs_project_created_idx').on(
      table.projectId,
      table.createdAt,
      bytewise(table.id),
    ),
    index('workflow_runs_status_created_idx').on(
      table.status,
      table.createdAt,
      bytewise(table.id),
    ),
  ],
);

export const workflowEffects = pgTable(
  'workflow_effects',
  {
    key: text('effect_key').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    status: workflowEffectStatus('status').notNull(),
    externalRef: text('external_ref'),
    output: json('output'),
    error: text('error'),
    ownerId: text('owner_id'),
    leaseVersion: integer('lease_version').notNull().default(0),
    leaseExpiresAt: instant('lease_expires_at'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    index('workflow_effects_run_status_idx').on(
      table.runId,
      table.status,
      table.createdAt,
      bytewise(table.key),
    ),
  ],
);

export const workflowSessionLeases = pgTable('workflow_session_leases', {
  leaseKey: text('lease_key').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'cascade' }),
  stepKey: text('step_key').notNull(),
  expiresAt: instant('expires_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
});

export const workflowBudgetReservations = pgTable(
  'workflow_budget_reservations',
  {
    reservationKey: text('reservation_key').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    estimatedMicrodollars: bigint('estimated_microdollars', {
      mode: 'number',
    }).notNull(),
    expiresAt: instant('expires_at').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    index('workflow_budget_reservations_run_idx').on(
      table.runId,
      table.expiresAt,
      bytewise(table.reservationKey),
    ),
  ],
);

export const configSnapshots = pgTable(
  'config_snapshots',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    configRevisionId: text('config_revision_id')
      .notNull()
      .references(() => configRevisions.id, { onDelete: 'restrict' }),
    config: json('config').notNull(),
    configDigest: text('config_digest').notNull(),
    modelDigest: text('model_digest').notNull(),
    promptDigest: text('prompt_digest').notNull(),
    environmentDigest: text('environment_digest').notNull(),
    policyDigest: text('policy_digest').notNull(),
    repositorySha: text('repository_sha').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    index('config_snapshots_run_created_idx').on(
      table.runId,
      table.createdAt,
      bytewise(table.id),
    ),
  ],
);

export const stepRuns = pgTable(
  'step_runs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    attempt: integer('attempt').notNull(),
    status: runStatus('status').notNull(),
    input: json('input'),
    output: json('output'),
    error: json('error'),
    externalSessionId: text('external_session_id').references(
      (): AnyPgColumn => externalSessions.id,
      { onDelete: 'set null' },
    ),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
    startedAt: instant('started_at'),
    completedAt: instant('completed_at'),
    cleanupAt: instant('cleanup_at'),
  },
  (table) => [
    unique('step_runs_run_step_attempt_unique').on(
      table.runId,
      table.stepKey,
      table.attempt,
    ),
    check('step_runs_attempt_positive', sql`${table.attempt} > 0`),
    index('step_runs_cleanup_idx')
      .on(table.cleanupAt)
      .where(sql`${table.cleanupAt} is not null`),
    index('step_runs_run_order_idx').on(
      table.runId,
      bytewise(table.stepKey),
      table.attempt,
    ),
  ],
);

export const externalSessions = pgTable(
  'external_sessions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stepRunId: text('step_run_id').references(() => stepRuns.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    status: externalSessionStatus('status').notNull(),
    state: json('state'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at'),
    cleanupAt: instant('cleanup_at'),
  },
  (table) => [
    unique('external_sessions_provider_external_unique').on(
      table.provider,
      table.externalId,
    ),
    index('external_sessions_cleanup_idx')
      .on(table.cleanupAt)
      .where(sql`${table.cleanupAt} is not null`),
    index('external_sessions_run_created_idx').on(
      table.runId,
      table.createdAt,
      bytewise(table.id),
    ),
    index('external_sessions_run_provider_created_idx').on(
      table.runId,
      table.provider,
      table.createdAt,
      bytewise(table.id),
    ),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: approvalStatus('status').notNull(),
    createdAt: instant('created_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
    consumedAt: instant('consumed_at'),
  },
  (table) => [
    index('approvals_run_created_idx').on(
      table.runId,
      table.createdAt,
      bytewise(table.id),
    ),
    index('approvals_run_status_created_idx').on(
      table.runId,
      table.status,
      table.createdAt,
      bytewise(table.id),
    ),
  ],
);

export const inboxMessages = pgTable(
  'inbox_messages',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stepRunId: text('step_run_id').references(() => stepRuns.id, {
      onDelete: 'set null',
    }),
    status: inboxStatus('status').notNull(),
    body: json('body').notNull(),
    reply: json('reply'),
    createdAt: instant('created_at').notNull(),
    repliedAt: instant('replied_at'),
  },
  (table) => [
    index('inbox_messages_pending_idx')
      .on(table.runId, table.createdAt, bytewise(table.id))
      .where(sql`${table.status} = 'pending'`),
    index('inbox_messages_run_created_idx').on(
      table.runId,
      table.createdAt,
      bytewise(table.id),
    ),
    index('inbox_messages_run_status_created_idx').on(
      table.runId,
      table.status,
      table.createdAt,
      bytewise(table.id),
    ),
  ],
);

export const domainEvents = pgTable(
  'domain_events',
  {
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    payload: json('payload'),
    occurredAt: instant('occurred_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.eventId] }),
    unique('domain_events_run_sequence_unique').on(table.runId, table.sequence),
    check('domain_events_sequence_nonnegative', sql`${table.sequence} >= 0`),
    check(
      'domain_events_sequence_safe_integer',
      sql`${table.sequence} <= 9007199254740991`,
    ),
    index('domain_events_order_idx').on(table.runId, table.sequence),
  ],
);

export const runEventSequences = pgTable(
  'run_event_sequences',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    nextSequence: bigint('next_sequence', { mode: 'number' })
      .notNull()
      .default(1),
  },
  (table) => [
    check('run_event_sequences_next_positive', sql`${table.nextSequence} > 0`),
    check(
      'run_event_sequences_next_safe_integer',
      sql`${table.nextSequence} <= 9007199254740992`,
    ),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stepRunId: text('step_run_id').references(() => stepRuns.id, {
      onDelete: 'set null',
    }),
    key: text('key').notNull(),
    mediaType: text('media_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    digest: text('digest').notNull(),
    uri: text('uri'),
    retentionClass: text('retention_class'),
    createdAt: instant('created_at').notNull(),
    cleanupAt: instant('cleanup_at'),
    deletedAt: instant('deleted_at'),
    deletionReason: text('deletion_reason'),
    deletionState: text('deletion_state'),
    deletionRequestedAt: instant('deletion_requested_at'),
    writeLeaseId: text('write_lease_id'),
    writeLeaseExpiresAt: instant('write_lease_expires_at'),
    manifestVersion: text('manifest_version'),
  },
  (table) => [
    unique('artifacts_run_key_unique').on(table.runId, table.key),
    check(
      'artifacts_size_nonnegative',
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
    ),
    check(
      'artifacts_size_safe_integer',
      sql`${table.sizeBytes} is null or ${table.sizeBytes} <= 9007199254740991`,
    ),
    index('artifacts_cleanup_idx')
      .on(table.cleanupAt)
      .where(
        sql`${table.cleanupAt} is not null and ${table.deletedAt} is null and ${table.manifestVersion} = 'artifact-manifest-v1' and ${table.deletionState} in ('active', 'pending')`,
      ),
    index('artifacts_run_key_scan_idx').on(table.runId, bytewise(table.key)),
    index('artifacts_run_created_idx').on(
      table.runId,
      table.createdAt,
      bytewise(table.id),
    ),
  ],
);

export const artifactCapabilityQuotas = pgTable(
  'artifact_capability_quotas',
  {
    purpose: text('purpose').notNull(),
    audience: text('audience').notNull(),
    nonce: text('nonce').notNull(),
    fingerprint: text('fingerprint').notNull(),
    notBefore: instant('not_before').notNull(),
    expiresAt: instant('expires_at').notNull(),
    calls: bigint('calls', { mode: 'number' }).notNull(),
    cumulativeBytes: bigint('cumulative_bytes', { mode: 'number' }).notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.purpose, table.audience, table.nonce] }),
    check('artifact_capability_quota_calls_positive', sql`${table.calls} > 0`),
    check(
      'artifact_capability_quota_calls_safe_integer',
      sql`${table.calls} <= 9007199254740991`,
    ),
    check(
      'artifact_capability_quota_bytes_nonnegative',
      sql`${table.cumulativeBytes} >= 0`,
    ),
    check(
      'artifact_capability_quota_bytes_safe_integer',
      sql`${table.cumulativeBytes} <= 9007199254740991`,
    ),
    check(
      'artifact_capability_quota_window',
      sql`${table.expiresAt} > ${table.notBefore}`,
    ),
    index('artifact_capability_quotas_expiry_idx').on(table.expiresAt),
  ],
);

export const artifactCleanupLeases = pgTable('artifact_cleanup_leases', {
  name: text('name').primaryKey(),
  owner: text('owner').notNull(),
  expiresAt: instant('expires_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
});

export const usageRecords = pgTable(
  'usage_records',
  {
    idempotencyId: text('idempotency_id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stepRunId: text('step_run_id').references(() => stepRuns.id, {
      onDelete: 'set null',
    }),
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
    runtimeMs: bigint('runtime_ms', { mode: 'number' }).notNull(),
    microdollars: bigint('microdollars', { mode: 'number' }).notNull(),
    recordedAt: instant('recorded_at').notNull(),
  },
  (table) => [
    check('usage_input_nonnegative', sql`${table.inputTokens} >= 0`),
    check(
      'usage_input_safe_integer',
      sql`${table.inputTokens} <= 9007199254740991`,
    ),
    check('usage_output_nonnegative', sql`${table.outputTokens} >= 0`),
    check(
      'usage_output_safe_integer',
      sql`${table.outputTokens} <= 9007199254740991`,
    ),
    check('usage_runtime_nonnegative', sql`${table.runtimeMs} >= 0`),
    check(
      'usage_runtime_safe_integer',
      sql`${table.runtimeMs} <= 9007199254740991`,
    ),
    check('usage_cost_nonnegative', sql`${table.microdollars} >= 0`),
    check(
      'usage_cost_safe_integer',
      sql`${table.microdollars} <= 9007199254740991`,
    ),
    index('usage_records_run_recorded_idx').on(
      table.runId,
      table.recordedAt,
      bytewise(table.idempotencyId),
    ),
  ],
);

export const webhookReceipts = pgTable(
  'webhook_receipts',
  {
    source: text('source').notNull(),
    deliveryId: text('delivery_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    claimToken: text('claim_token').notNull(),
    receivedAt: instant('received_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.deliveryId] }),
    index('webhook_receipts_expiry_idx').on(table.expiresAt),
  ],
);

export const goalCriteria = pgTable(
  'goal_criteria',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    description: text('description').notNull(),
    status: goalStatus('status').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    unique('goal_criteria_run_ordinal_unique').on(table.runId, table.ordinal),
    check('goal_criteria_ordinal_nonnegative', sql`${table.ordinal} >= 0`),
  ],
);

export const goalProgress = pgTable(
  'goal_progress',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    criterionId: text('criterion_id').references(() => goalCriteria.id, {
      onDelete: 'cascade',
    }),
    status: goalStatus('status').notNull(),
    detail: text('detail'),
    payload: json('payload'),
    recordedAt: instant('recorded_at').notNull(),
  },
  (table) => [
    index('goal_progress_order_idx').on(
      table.runId,
      table.recordedAt,
      bytewise(table.id),
    ),
  ],
);

export const publicationRecords = pgTable(
  'publication_records',
  {
    key: text('publication_key').primaryKey(),
    bindingKey: text('binding_key').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    manifestDigest: text('manifest_digest').notNull(),
    policyDigest: text('policy_digest').notNull(),
    baseSha: text('base_sha').notNull(),
    branch: text('branch').notNull(),
    phase: text('phase').notNull(),
    blobShas: jsonb('blob_shas').$type<Record<string, string>>(),
    treeSha: text('tree_sha'),
    commitSha: text('commit_sha'),
    pullRequestNumber: bigint('pull_request_number', { mode: 'number' }),
    pullRequestUrl: text('pull_request_url'),
    draft: boolean('draft'),
    errorCode: text('error_code'),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    unique('publication_records_binding_key_unique').on(table.bindingKey),
    check(
      'publication_records_repository_id_positive',
      sql`${table.repositoryId} > 0`,
    ),
    check(
      'publication_records_repository_id_safe',
      sql`${table.repositoryId} <= 9007199254740991`,
    ),
    check('publication_records_revision_positive', sql`${table.revision} > 0`),
    check(
      'publication_records_revision_safe',
      sql`${table.revision} <= 9007199254740991`,
    ),
    check(
      'publication_records_phase_valid',
      sql`${table.phase} in ('claimed','blobs_created','tree_created','commit_created','ref_created','pr_created','succeeded','cancelled','failed')`,
    ),
    check(
      'publication_records_key_digest',
      sql`${table.key} ~ '^[0-9a-f]{64}$' and ${table.bindingKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'publication_records_manifest_policy_digests',
      sql`${table.manifestDigest} ~ '^[0-9a-f]{64}$' and ${table.policyDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'publication_records_git_shas',
      sql`${table.baseSha} ~ '^[0-9a-f]{40}$' and (${table.treeSha} is null or ${table.treeSha} ~ '^[0-9a-f]{40}$') and (${table.commitSha} is null or ${table.commitSha} ~ '^[0-9a-f]{40}$')`,
    ),
    check(
      'publication_records_branch_namespace',
      sql`${table.branch} ~ '^agentos/[a-z0-9._-]{1,100}-[0-9a-f]{8}$'`,
    ),
    check(
      'publication_records_pull_request_shape',
      sql`(${table.pullRequestNumber} is null or ${table.pullRequestNumber} > 0) and (${table.draft} is null or ${table.draft} is true) and (${table.pullRequestUrl} is null or ${table.pullRequestUrl} like 'https://github.com/%')`,
    ),
    index('publication_records_run_idx').on(table.runId, table.createdAt),
  ],
);

export const publicationEvents = pgTable(
  'publication_events',
  {
    sequence: bigserial('sequence', { mode: 'number' }).primaryKey(),
    publicationKey: text('publication_key')
      .notNull()
      .references(() => publicationRecords.key, { onDelete: 'cascade' }),
    phase: text('phase').notNull(),
    at: instant('at').notNull(),
    details: jsonb('details')
      .$type<Record<string, string | number | boolean>>()
      .notNull(),
  },
  (table) => [
    index('publication_events_order_idx').on(
      table.publicationKey,
      table.sequence,
    ),
  ],
);
