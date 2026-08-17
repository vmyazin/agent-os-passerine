import { neon } from '@neondatabase/serverless';
import type { JsonValue } from '@agentos/core';

import { databaseUrlFromEnv } from '../persistence/database-config.js';
import { WorkflowCheckpointConflictError } from './checkpoint-store.js';
import type {
  WorkflowCheckpointStore,
  WorkflowEffect,
  WorkflowSessionAdmission,
} from './types.js';

export interface WorkflowCheckpointSqlExecutor {
  execute(
    query: string,
    parameters: readonly unknown[],
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
}

function effect(row: Readonly<Record<string, unknown>>): WorkflowEffect {
  const output = row.output as JsonValue | null | undefined;
  return {
    key: String(row.key),
    runId: String(row.runId),
    kind: String(row.kind),
    inputFingerprint: String(row.inputFingerprint),
    status: String(row.status) as WorkflowEffect['status'],
    ...(row.externalRef === null || row.externalRef === undefined
      ? {}
      : { externalRef: String(row.externalRef) }),
    ...(output === null || output === undefined ? {} : { output }),
    ...(row.error === null || row.error === undefined
      ? {}
      : { error: String(row.error) }),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

const selection = `"effect_key" as "key", "run_id" as "runId", "kind",
  "input_fingerprint" as "inputFingerprint", "status",
  "external_ref" as "externalRef", "output", "error",
  to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
  to_char("updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"`;

export class PostgresWorkflowCheckpointStore implements WorkflowCheckpointStore {
  constructor(private readonly sql: WorkflowCheckpointSqlExecutor) {}

  async claimEffect(
    draft: Omit<WorkflowEffect, 'status'>,
  ): Promise<WorkflowEffect> {
    const rows = await this.sql.execute(
      `insert into "workflow_effects"
        ("effect_key", "run_id", "kind", "input_fingerprint", "status", "external_ref", "output", "error", "created_at", "updated_at")
       values ($1, $2, $3, $4, 'pending', $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz)
       on conflict ("effect_key") do update set "effect_key" = excluded."effect_key"
       returning ${selection}`,
      [
        draft.key,
        draft.runId,
        draft.kind,
        draft.inputFingerprint,
        draft.externalRef ?? null,
        draft.output === undefined ? null : JSON.stringify(draft.output),
        draft.error ?? null,
        draft.createdAt,
        draft.updatedAt,
      ],
    );
    const value = effect(rows[0] ?? {});
    if (
      value.runId !== draft.runId ||
      value.kind !== draft.kind ||
      value.inputFingerprint !== draft.inputFingerprint
    ) {
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${draft.key} was replayed with different input`,
      );
    }
    return value;
  }

  async markEffectStarted(key: string, now: string): Promise<WorkflowEffect> {
    await this.sql.execute(
      `update "workflow_effects" set "status" = 'started', "updated_at" = $2::timestamptz
       where "effect_key" = $1 and "status" = 'pending'`,
      [key, now],
    );
    return this.#require(key);
  }

  async attachExternalRef(
    key: string,
    externalRef: string,
    now: string,
  ): Promise<WorkflowEffect> {
    const rows = await this.sql.execute(
      `update "workflow_effects" set "external_ref" = $2, "updated_at" = $3::timestamptz
       where "effect_key" = $1 and "status" = 'started'
         and ("external_ref" is null or "external_ref" = $2)
       returning ${selection}`,
      [key, externalRef, now],
    );
    if (rows[0] === undefined)
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${key} cannot attach an external reference`,
      );
    return effect(rows[0]);
  }

  async completeEffect(
    key: string,
    output: JsonValue,
    now: string,
  ): Promise<WorkflowEffect> {
    const encoded = JSON.stringify(output);
    const rows = await this.sql.execute(
      `update "workflow_effects" set "status" = 'succeeded', "output" = $2::jsonb,
         "updated_at" = $3::timestamptz
       where "effect_key" = $1 and
         ("status" = 'started' or ("status" = 'succeeded' and "output" = $2::jsonb))
       returning ${selection}`,
      [key, encoded, now],
    );
    if (rows[0] === undefined)
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${key} cannot be completed`,
      );
    return effect(rows[0]);
  }

  async failEffect(
    key: string,
    error: string,
    deadLetter: boolean,
    now: string,
  ): Promise<WorkflowEffect> {
    const rows = await this.sql.execute(
      `update "workflow_effects" set "status" = $2::workflow_effect_status,
         "error" = left($3, 1000), "updated_at" = $4::timestamptz
       where "effect_key" = $1 and "status" <> 'succeeded'
       returning ${selection}`,
      [key, deadLetter ? 'dead_letter' : 'failed', error, now],
    );
    return rows[0] === undefined ? this.#require(key) : effect(rows[0]);
  }

  async getEffect(key: string): Promise<WorkflowEffect | undefined> {
    const rows = await this.sql.execute(
      `select ${selection} from "workflow_effects" where "effect_key" = $1 limit 1`,
      [key],
    );
    return rows[0] === undefined ? undefined : effect(rows[0]);
  }

  async listEffects(runId: string): Promise<readonly WorkflowEffect[]> {
    const rows = await this.sql.execute(
      `select ${selection} from "workflow_effects" where "run_id" = $1
       order by "effect_key" collate "C" limit 1000`,
      [runId],
    );
    return rows.map(effect);
  }

  async admitSession(request: WorkflowSessionAdmission): Promise<
    | { readonly admitted: true }
    | {
        readonly admitted: false;
        readonly reason: 'workflow_budget' | 'daily_budget' | 'concurrency';
      }
  > {
    const rows = await this.sql.execute(
      `select "agentos_admit_workflow_session"(
        $1, $2, $3::bigint, $4::bigint, $5::integer, $6::integer,
        $7::timestamptz, $8::timestamptz
      ) as "result"`,
      [
        request.runId,
        request.stepKey,
        request.workflowLimitMicrodollars,
        request.dailyLimitMicrodollars,
        request.admissionNumerator,
        request.admissionDenominator,
        request.now,
        request.leaseExpiresAt,
      ],
    );
    const result = String(rows[0]?.result);
    if (result === 'admitted') return { admitted: true };
    if (
      result !== 'workflow_budget' &&
      result !== 'daily_budget' &&
      result !== 'concurrency'
    ) {
      throw new Error('workflow admission returned an invalid result');
    }
    return { admitted: false, reason: result };
  }

  async releaseSession(runId: string, stepKey: string): Promise<void> {
    await this.sql.execute(
      `delete from "workflow_session_leases"
       where "lease_key" = 'global-agent-session' and "run_id" = $1 and "step_key" = $2`,
      [runId, stepKey],
    );
  }

  async #require(key: string): Promise<WorkflowEffect> {
    const value = await this.getEffect(key);
    if (value === undefined)
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${key} does not exist`,
      );
    return value;
  }
}

export function createPostgresWorkflowCheckpointStoreForTest(
  executor: WorkflowCheckpointSqlExecutor,
): WorkflowCheckpointStore {
  return new PostgresWorkflowCheckpointStore(executor);
}

export function createNeonWorkflowCheckpointStore(
  environment: Readonly<Record<string, string | undefined>>,
): WorkflowCheckpointStore {
  const sql = neon(databaseUrlFromEnv(environment), {
    arrayMode: false,
    fullResults: false,
  });
  return new PostgresWorkflowCheckpointStore({
    execute: async (query, parameters) =>
      (await sql.query(query, [...parameters])) as readonly Readonly<
        Record<string, unknown>
      >[],
  });
}
