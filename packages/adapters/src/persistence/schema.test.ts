import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  approvals,
  artifacts,
  configRevisions,
  configSnapshots,
  domainEvents,
  externalSessions,
  inboxMessages,
  projects,
  stepRuns,
  usageRecords,
  webhookReceipts,
  workflowRuns,
} from './schema.js';

describe('Drizzle persistence schema', () => {
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
