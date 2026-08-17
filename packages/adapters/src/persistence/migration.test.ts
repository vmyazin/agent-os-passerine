import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = resolve(process.cwd(), '../../drizzle');
const migration = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(resolve(migrationDirectory, name), 'utf8'))
  .join('\n')
  .toLowerCase();
const artifactMigration = readFileSync(
  resolve(migrationDirectory, '0008_concerned_wither.sql'),
  'utf8',
).toLowerCase();

describe('domain persistence migration', () => {
  it.each([
    'projects',
    'config_revisions',
    'config_snapshots',
    'workflow_runs',
    'step_runs',
    'external_sessions',
    'approvals',
    'inbox_messages',
    'domain_events',
    'artifacts',
    'artifact_capability_quotas',
    'artifact_cleanup_leases',
    'usage_records',
    'webhook_receipts',
    'goal_criteria',
    'goal_progress',
  ])('creates the %s table', (table) => {
    expect(migration).toContain(`create table "${table}"`);
  });

  it('preserves snapshots and structured payloads in jsonb columns', () => {
    expect(migration.match(/jsonb/g)?.length).toBeGreaterThanOrEqual(12);
    expect(migration).toContain('"repository_sha" text not null');
    expect(migration).toContain('"model_digest" text not null');
    expect(migration).toContain('"prompt_digest" text not null');
    expect(migration).toContain('"environment_digest" text not null');
    expect(migration).toContain('"policy_digest" text not null');
  });

  it('defines uniqueness and foreign-key boundaries for idempotency', () => {
    expect(migration).toContain('unique("project_id","revision")');
    expect(migration).toContain('unique("run_id","step_key","attempt")');
    expect(migration).toContain('primary key("run_id","event_id")');
    expect(migration).toContain('primary key("source","delivery_id")');
    expect(migration).toContain('"idempotency_id" text primary key not null');
    expect(migration).toContain('foreign key ("external_session_id")');
    expect(
      migration.match(/references "public"\./g)?.length,
    ).toBeGreaterThanOrEqual(14);
  });

  it('indexes operational queries and cleanup scans', () => {
    for (const index of [
      'workflow_runs_status_idx',
      'inbox_messages_pending_idx',
      'domain_events_order_idx',
      'workflow_runs_cleanup_idx',
      'step_runs_cleanup_idx',
      'artifacts_cleanup_idx',
      'artifact_capability_quotas_expiry_idx',
      'webhook_receipts_expiry_idx',
    ]) {
      expect(migration).toContain(`index "${index}"`);
    }
  });

  it('persists manifest discrimination, capability budgets, and cleanup leases', () => {
    expect(migration).toContain('"manifest_version" text');
    expect(migration).toContain('"deletion_state" text');
    expect(migration).toContain('"write_lease_id" text');
    expect(migration).toContain('primary key("purpose","audience","nonce")');
    expect(migration).toContain(
      '"expires_at" timestamp with time zone not null',
    );
  });

  it('backfills only structurally valid v1 artifact manifest rows', () => {
    expect(artifactMigration).toContain('update "artifacts" as "artifact"');
    expect(artifactMigration).toContain('from "workflow_runs" as "run"');
    expect(artifactMigration).toContain(
      `set "manifest_version" = 'artifact-manifest-v1',`,
    );
    expect(artifactMigration).toContain(
      `when "artifact"."deleted_at" is null then 'active'`,
    );
    expect(artifactMigration).toContain(
      `"artifact"."key" like 'artifact-manifest/v1/%'`,
    );
    expect(artifactMigration).toContain('"artifact"."uri" =');
    expect(artifactMigration).toContain(
      '"artifact"."media_type" = lower(btrim("artifact"."media_type"))',
    );
    expect(artifactMigration).toContain(
      '"artifact"."cleanup_at" > "artifact"."created_at"',
    );
    expect(artifactMigration).toContain("interval '23 hours 45 minutes'");
    expect(artifactMigration).toContain(
      '"artifact"."digest" = split_part("artifact"."uri", \'/\', 9)',
    );
  });

  it('constrains status and money values', () => {
    expect(migration).toContain('create type "public"."run_status" as enum');
    expect(migration).toContain(
      'create type "public"."approval_status" as enum',
    );
    expect(migration).toContain('"microdollars" bigint not null');
    expect(migration).toContain('check ("usage_records"."microdollars" >= 0)');
  });

  it('backfills stable webhook claim tokens before enforcing not-null', () => {
    expect(migration).toContain(
      'alter table "webhook_receipts" add column "claim_token" text;',
    );
    expect(migration).toContain('update "webhook_receipts"');
    expect(migration).toContain('alter column "claim_token" set not null');
  });

  it('serializes event mutations with deterministic per-run advisory locks', () => {
    for (const functionName of [
      'agentos_append_event',
      'agentos_cancel_run_with_event',
      'agentos_consume_approval_with_event',
      'agentos_reply_inbox_with_event',
    ]) {
      expect(migration).toContain(`function "${functionName}"`);
    }
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('hashtextextended');
    expect(migration).toContain('agentos_event_conflict');
  });

  it('bounds bigint values and indexes every production list path', () => {
    expect(migration).toContain('9007199254740991');
    for (const index of [
      'projects_created_idx',
      'config_revisions_project_created_idx',
      'config_snapshots_run_created_idx',
      'external_sessions_run_created_idx',
      'external_sessions_run_provider_created_idx',
      'approvals_run_created_idx',
      'approvals_run_status_created_idx',
      'inbox_messages_run_created_idx',
      'inbox_messages_run_status_created_idx',
      'artifacts_run_created_idx',
      'usage_records_run_recorded_idx',
      'workflow_runs_created_idx',
      'workflow_runs_project_created_idx',
      'workflow_runs_status_created_idx',
      'step_runs_run_order_idx',
    ]) {
      expect(migration).toContain(`index "${index}"`);
    }
    expect(migration).toContain('collate "c"');
  });
});
