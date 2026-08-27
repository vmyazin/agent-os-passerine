import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  approvals,
  artifacts,
  configRevisions,
  configSnapshots,
  domainEvents,
  externalSessions,
  goalCriteria,
  goalProgress,
  inboxMessages,
  projects,
  projectSources,
  projectSourceImportRequests,
  stepRuns,
  usageRecords,
  webhookReceipts,
  workflowRuns,
  userPreferences,
} from './schema.js';

describe('Drizzle persistence schema', () => {
  it('keys extensible user preferences by operator login', () => {
    const config = getTableConfig(userPreferences);
    expect(
      config.columns.find((column) => column.name === 'login')?.primary,
    ).toBe(true);
    expect(config.columns.map((column) => column.name)).toEqual([
      'login',
      'time_zone',
      'updated_at',
    ]);
    expect(config.checks.map((item) => item.name)).toContain(
      'user_preferences_required_text',
    );
  });

  it('maps Neon Date values to canonical ISO timestamps without shifting the instant', () => {
    expect(
      projects.createdAt.mapFromDriverValue(
        new Date('2026-08-16T12:00:00.123Z') as never,
      ),
    ).toBe('2026-08-16T12:00:00.123Z');
  });

  it('models idempotency keys as primary or unique constraints', () => {
    expect(getTableConfig(stepRuns).uniqueConstraints).toHaveLength(1);
    expect(getTableConfig(domainEvents).primaryKeys).toHaveLength(1);
    expect(
      getTableConfig(usageRecords).columns.find(
        (column) => column.name === 'idempotency_id',
      )?.primary,
    ).toBe(true);
    expect(getTableConfig(webhookReceipts).primaryKeys).toHaveLength(1);
    expect(
      getTableConfig(projectSourceImportRequests).columns.find(
        (column) => column.name === 'idempotency_key',
      )?.primary,
    ).toBe(true);
    expect(
      getTableConfig(projectSources).uniqueConstraints.map(
        (constraint) => constraint.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        'project_sources_source_key_unique',
        'project_sources_repository_id_unique',
      ]),
    );
  });

  it('enforces one exact provider-shaped source per project', () => {
    const config = getTableConfig(projectSources);
    expect(
      config.columns.find((column) => column.name === 'project_id')?.primary,
    ).toBe(true);
    expect(config.checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'project_sources_kind_valid',
        'project_sources_provider_shape',
        'project_sources_repository_id_safe',
        'project_sources_reader_installation_id_safe',
        'project_sources_publisher_installation_id_safe',
      ]),
    );
  });

  it('keeps operational indexes in the executable schema', () => {
    expect(
      getTableConfig(workflowRuns).indexes.map((index) => index.config.name),
    ).toContain('workflow_runs_status_idx');
    expect(
      getTableConfig(inboxMessages).indexes.map((index) => index.config.name),
    ).toContain('inbox_messages_pending_idx');
    expect(
      getTableConfig(domainEvents).indexes.map((index) => index.config.name),
    ).toContain('domain_events_order_idx');
    expect(
      getTableConfig(configRevisions).indexes.map((index) => index.config.name),
    ).toContain('config_revisions_project_created_idx');
    expect(
      getTableConfig(configSnapshots).indexes.map((index) => index.config.name),
    ).toContain('config_snapshots_run_created_idx');
    expect(
      getTableConfig(externalSessions).indexes.map(
        (index) => index.config.name,
      ),
    ).toContain('external_sessions_run_provider_created_idx');
    expect(
      getTableConfig(approvals).indexes.map((index) => index.config.name),
    ).toContain('approvals_run_status_created_idx');
    expect(
      getTableConfig(usageRecords).indexes.map((index) => index.config.name),
    ).toContain('usage_records_run_recorded_idx');
  });

  it('uses database enums for state machines', () => {
    expect(
      getTableConfig(workflowRuns).columns.find(
        (column) => column.name === 'status',
      )?.columnType,
    ).toContain('Enum');
    expect(
      getTableConfig(approvals).columns.find(
        (column) => column.name === 'status',
      )?.columnType,
    ).toContain('Enum');
  });

  it('stores immutable goal definitions and bounds progress to three steps', () => {
    expect(
      getTableConfig(goalCriteria).columns.map((column) => column.name),
    ).toContain('definition');
    expect(
      getTableConfig(goalProgress).columns.map((column) => column.name),
    ).toContain('step');
    expect(
      getTableConfig(goalProgress).checks.map((item) => item.name),
    ).toContain('goal_progress_step_between_1_and_3');
  });

  it('bounds number-mode BIGINT columns to JavaScript safe integers', () => {
    expect(
      getTableConfig(domainEvents).checks.map((item) => item.name),
    ).toContain('domain_events_sequence_safe_integer');
    expect(getTableConfig(artifacts).checks.map((item) => item.name)).toContain(
      'artifacts_size_safe_integer',
    );
    for (const name of [
      'usage_input_safe_integer',
      'usage_output_safe_integer',
      'usage_runtime_safe_integer',
      'usage_cost_safe_integer',
    ]) {
      expect(
        getTableConfig(usageRecords).checks.map((item) => item.name),
      ).toContain(name);
    }
  });
});
