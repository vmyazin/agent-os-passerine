import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  approvals,
  domainEvents,
  inboxMessages,
  stepRuns,
  usageRecords,
  webhookReceipts,
  workflowRuns,
} from './schema.js';

describe('Drizzle persistence schema', () => {
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
});
