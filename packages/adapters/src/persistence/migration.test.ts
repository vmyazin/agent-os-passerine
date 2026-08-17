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
      'webhook_receipts_expiry_idx',
    ]) {
      expect(migration).toContain(`index "${index}"`);
    }
  });

  it('constrains status and money values', () => {
    expect(migration).toContain('create type "public"."run_status" as enum');
    expect(migration).toContain(
      'create type "public"."approval_status" as enum',
    );
    expect(migration).toContain('"microdollars" bigint not null');
    expect(migration).toContain('check ("usage_records"."microdollars" >= 0)');
  });
});
