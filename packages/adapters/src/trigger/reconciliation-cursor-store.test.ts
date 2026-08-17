import { isoTimestamp, persistenceId } from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { PostgresWorkflowReconciliationCursorStore } from './reconciliation-cursor-store.js';

describe('Postgres workflow reconciliation cursor store', () => {
  it('round-trips the durable cursor and deletes it when a cycle completes', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          cursorAt: '2026-08-17T12:00:00.000000Z',
          cursorId: 'run-100',
        },
      ])
      .mockResolvedValue([]);
    const store = new PostgresWorkflowReconciliationCursorStore({ execute });

    await expect(store.load()).resolves.toEqual({
      at: '2026-08-17T12:00:00.000000Z',
      id: 'run-100',
    });
    await store.save({
      at: isoTimestamp('2026-08-17T12:00:00.000Z'),
      id: persistenceId('run', 'run-101'),
    });
    await store.save(undefined);

    expect(execute.mock.calls[1]?.[0]).toContain('on conflict');
    expect(execute.mock.calls[1]?.[0]).toContain('collate "C"');
    expect(execute.mock.calls[1]?.[1]).toEqual([
      'feature-workflow-outbox-v1',
      '2026-08-17T12:00:00.000Z',
      'run-101',
    ]);
    expect(execute.mock.calls[2]?.[0]).toContain('delete from');
  });
});
