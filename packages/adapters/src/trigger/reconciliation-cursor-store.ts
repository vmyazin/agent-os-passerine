// packages/adapters/src/trigger/reconciliation-cursor-store.ts
import { neon } from '@neondatabase/serverless';
import {
  isoTimestamp,
  persistenceId,
  type ProjectId,
  type TimestampListCursor,
  type WorkflowRunId,
} from '@agentos/core';

import { databaseUrlFromEnv } from '../persistence/database-config.js';
import type { WorkflowCheckpointSqlExecutor } from './postgres-checkpoint-store.js';

export function reconciliationCursorKey(projectId: ProjectId): string {
  return `feature-workflow-outbox-v1:${projectId}`;
}

export interface DurableWorkflowReconciliationCursorStore {
  load(): Promise<TimestampListCursor<WorkflowRunId> | undefined>;
  save(cursor: TimestampListCursor<WorkflowRunId> | undefined): Promise<void>;
}

export class PostgresWorkflowReconciliationCursorStore implements DurableWorkflowReconciliationCursorStore {
  constructor(
    private readonly sql: WorkflowCheckpointSqlExecutor,
    private readonly cursorKey: string,
  ) {}

  async load(): Promise<TimestampListCursor<WorkflowRunId> | undefined> {
    const rows = await this.sql.execute(
      `select
         to_char("cursor_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt",
         "cursor_id" as "cursorId"
       from "workflow_reconciliation_cursors"
       where "cursor_key" = $1`,
      [this.cursorKey],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      at: isoTimestamp(String(row.cursorAt)),
      id: persistenceId('run', String(row.cursorId)),
    };
  }

  async save(
    cursor: TimestampListCursor<WorkflowRunId> | undefined,
  ): Promise<void> {
    if (cursor === undefined) {
      await this.sql.execute(
        `delete from "workflow_reconciliation_cursors"
         where "cursor_key" = $1`,
        [this.cursorKey],
      );
      return;
    }
    await this.sql.execute(
      `insert into "workflow_reconciliation_cursors"
         ("cursor_key", "cursor_at", "cursor_id", "updated_at")
       values ($1, $2::timestamptz, $3, now())
       on conflict ("cursor_key") do update set
         "cursor_at" = excluded."cursor_at",
         "cursor_id" = excluded."cursor_id",
         "updated_at" = excluded."updated_at"
       where (excluded."cursor_at", excluded."cursor_id" collate "C") >
         ("workflow_reconciliation_cursors"."cursor_at",
          "workflow_reconciliation_cursors"."cursor_id" collate "C")`,
      [this.cursorKey, cursor.at, cursor.id],
    );
  }
}

export function createNeonWorkflowReconciliationCursorStore(
  environment: Readonly<Record<string, string | undefined>>,
  projectId: ProjectId,
): DurableWorkflowReconciliationCursorStore {
  const sql = neon(databaseUrlFromEnv(environment), {
    arrayMode: false,
    fullResults: false,
  });
  return new PostgresWorkflowReconciliationCursorStore(
    {
      execute: async (query, parameters) =>
        (await sql.query(query, [...parameters])) as readonly Readonly<
          Record<string, unknown>
        >[],
    },
    reconciliationCursorKey(projectId),
  );
}
