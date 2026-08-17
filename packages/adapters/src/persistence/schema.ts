import { isoTimestamp, type IsoTimestamp, type JsonValue } from '@agentos/core';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
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
  return isoTimestamp(withOffsetMinutes);
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

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repository: text('repository'),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
});

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
    status: runStatus('status').notNull(),
    input: json('input'),
    output: json('output'),
    error: json('error'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
    startedAt: instant('started_at'),
    completedAt: instant('completed_at'),
    cleanupAt: instant('cleanup_at'),
  },
  (table) => [
    index('workflow_runs_status_idx').on(
      table.projectId,
      table.status,
      table.createdAt,
    ),
    index('workflow_runs_cleanup_idx')
      .on(table.cleanupAt)
      .where(sql`${table.cleanupAt} is not null`),
  ],
);

export const configSnapshots = pgTable('config_snapshots', {
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
});

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
  ],
);

export const approvals = pgTable('approvals', {
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
});

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
      .on(table.runId, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
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
    index('domain_events_order_idx').on(table.runId, table.sequence),
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
    createdAt: instant('created_at').notNull(),
    cleanupAt: instant('cleanup_at'),
  },
  (table) => [
    unique('artifacts_run_key_unique').on(table.runId, table.key),
    check(
      'artifacts_size_nonnegative',
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
    ),
    index('artifacts_cleanup_idx')
      .on(table.cleanupAt)
      .where(sql`${table.cleanupAt} is not null`),
  ],
);

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
    check('usage_output_nonnegative', sql`${table.outputTokens} >= 0`),
    check('usage_runtime_nonnegative', sql`${table.runtimeMs} >= 0`),
    check('usage_cost_nonnegative', sql`${table.microdollars} >= 0`),
  ],
);

export const webhookReceipts = pgTable(
  'webhook_receipts',
  {
    source: text('source').notNull(),
    deliveryId: text('delivery_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
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
    index('goal_progress_order_idx').on(table.runId, table.recordedAt),
  ],
);
