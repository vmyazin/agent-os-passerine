import { neon } from '@neondatabase/serverless';
import type { JsonValue } from '@agentos/core';

import { databaseUrlFromEnv } from '../persistence/database-config.js';
import { WorkflowCheckpointConflictError } from './checkpoint-store.js';
import type {
  WorkflowCheckpointStore,
  WorkflowEffect,
  WorkflowEffectClaim,
  WorkflowEffectLease,
  WorkflowSessionAdmission,
  WorkflowSessionSettlement,
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
    ...(row.ownerId === null || row.ownerId === undefined
      ? {}
      : { ownerId: String(row.ownerId) }),
    leaseVersion: Number(row.leaseVersion),
    ...(row.leaseExpiresAt === null || row.leaseExpiresAt === undefined
      ? {}
      : { leaseExpiresAt: String(row.leaseExpiresAt) }),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

const selection = `"effect_key" as "key", "run_id" as "runId", "kind",
  "input_fingerprint" as "inputFingerprint", "status",
  "external_ref" as "externalRef", "output", "error",
  "owner_id" as "ownerId", "lease_version" as "leaseVersion",
  to_char("lease_expires_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "leaseExpiresAt",
  to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
  to_char("updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"`;

export class PostgresWorkflowCheckpointStore implements WorkflowCheckpointStore {
  constructor(private readonly sql: WorkflowCheckpointSqlExecutor) {}

  async claimEffect(
    draft: Omit<
      WorkflowEffect,
      'status' | 'ownerId' | 'leaseVersion' | 'leaseExpiresAt'
    >,
    claim: WorkflowEffectClaim,
  ): Promise<WorkflowEffect> {
    const rows = await this.sql.execute(
      `insert into "workflow_effects"
        ("effect_key", "run_id", "kind", "input_fingerprint", "status", "external_ref", "output", "error", "owner_id", "lease_version", "lease_expires_at", "created_at", "updated_at")
       values ($1, $2, $3, $4, 'pending', $5, $6::jsonb, $7, $8, 1, $9::timestamptz, $10::timestamptz, $11::timestamptz)
       on conflict ("effect_key") do update set
         "owner_id" = case when "workflow_effects"."status" <> 'succeeded'
           and ("workflow_effects"."owner_id" = excluded."owner_id" or ("workflow_effects"."lease_expires_at" is null or "workflow_effects"."lease_expires_at" <= $11::timestamptz))
           then excluded."owner_id" else "workflow_effects"."owner_id" end,
         "lease_version" = case when "workflow_effects"."status" <> 'succeeded'
           and "workflow_effects"."owner_id" is distinct from excluded."owner_id"
           and ("workflow_effects"."lease_expires_at" is null or "workflow_effects"."lease_expires_at" <= $11::timestamptz)
           then "workflow_effects"."lease_version" + 1 else "workflow_effects"."lease_version" end,
         "lease_expires_at" = case when "workflow_effects"."status" <> 'succeeded'
           and ("workflow_effects"."owner_id" = excluded."owner_id" or ("workflow_effects"."lease_expires_at" is null or "workflow_effects"."lease_expires_at" <= $11::timestamptz))
           then excluded."lease_expires_at" else "workflow_effects"."lease_expires_at" end,
         "updated_at" = case when "workflow_effects"."status" <> 'succeeded'
           and ("workflow_effects"."owner_id" = excluded."owner_id" or ("workflow_effects"."lease_expires_at" is null or "workflow_effects"."lease_expires_at" <= $11::timestamptz))
           then excluded."updated_at" else "workflow_effects"."updated_at" end
       returning ${selection}`,
      [
        draft.key,
        draft.runId,
        draft.kind,
        draft.inputFingerprint,
        draft.externalRef ?? null,
        draft.output === undefined ? null : JSON.stringify(draft.output),
        draft.error ?? null,
        claim.ownerId,
        claim.leaseExpiresAt,
        draft.createdAt,
        claim.now,
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

  async markEffectStarted(
    lease: WorkflowEffectLease,
    now: string,
  ): Promise<WorkflowEffect> {
    const rows = await this.sql.execute(
      `update "workflow_effects" set "status" = 'started', "updated_at" = $2::timestamptz
       where "effect_key" = $1 and "owner_id" = $3 and "lease_version" = $4 and "status" in ('pending', 'failed')
       returning ${selection}`,
      [lease.key, now, lease.ownerId, lease.leaseVersion],
    );
    return rows[0] === undefined ? this.#owned(lease) : effect(rows[0]);
  }

  async attachExternalRef(
    lease: WorkflowEffectLease,
    externalRef: string,
    now: string,
  ): Promise<WorkflowEffect> {
    const rows = await this.sql.execute(
      `update "workflow_effects" set "external_ref" = $2, "updated_at" = $3::timestamptz
       where "effect_key" = $1 and "owner_id" = $4 and "lease_version" = $5 and "status" = 'started'
         and ("external_ref" is null or "external_ref" = $2)
       returning ${selection}`,
      [lease.key, externalRef, now, lease.ownerId, lease.leaseVersion],
    );
    if (rows[0] === undefined)
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${lease.key} cannot attach an external reference`,
      );
    return effect(rows[0]);
  }

  async completeEffect(
    lease: WorkflowEffectLease,
    output: JsonValue,
    now: string,
  ): Promise<WorkflowEffect> {
    const encoded = JSON.stringify(output);
    const rows = await this.sql.execute(
      `update "workflow_effects" set "status" = 'succeeded', "output" = $2::jsonb,
         "updated_at" = $3::timestamptz
       where "effect_key" = $1 and "owner_id" = $4 and "lease_version" = $5 and
         ("status" = 'started' or ("status" = 'succeeded' and "output" = $2::jsonb))
       returning ${selection}`,
      [lease.key, encoded, now, lease.ownerId, lease.leaseVersion],
    );
    if (rows[0] === undefined)
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${lease.key} cannot be completed`,
      );
    return effect(rows[0]);
  }

  async failEffect(
    lease: WorkflowEffectLease,
    error: string,
    deadLetter: boolean,
    now: string,
  ): Promise<WorkflowEffect> {
    const rows = await this.sql.execute(
      `update "workflow_effects" set "status" = $2::workflow_effect_status,
         "error" = left($3, 1000), "updated_at" = $4::timestamptz
       where "effect_key" = $1 and "owner_id" = $5 and "lease_version" = $6 and "status" <> 'succeeded'
       returning ${selection}`,
      [
        lease.key,
        deadLetter ? 'dead_letter' : 'failed',
        error,
        now,
        lease.ownerId,
        lease.leaseVersion,
      ],
    );
    return rows[0] === undefined ? this.#owned(lease) : effect(rows[0]);
  }

  async renewEffect(
    lease: WorkflowEffectLease,
    now: string,
    leaseExpiresAt: string,
  ): Promise<WorkflowEffect> {
    const rows = await this.sql.execute(
      `update "workflow_effects" set "lease_expires_at" = $2::timestamptz, "updated_at" = $3::timestamptz
       where "effect_key" = $1 and "owner_id" = $4 and "lease_version" = $5
       returning ${selection}`,
      [lease.key, leaseExpiresAt, now, lease.ownerId, lease.leaseVersion],
    );
    if (rows[0] === undefined)
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${lease.key} cannot renew fencing lease`,
      );
    return effect(rows[0]);
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
        $1, $2, $3, $4, $5::bigint, $6::bigint, $7::bigint,
        $8::integer, $9::integer, $10::timestamptz, $11::timestamptz,
        $12::bigint
      ) as "result"`,
      [
        request.runId,
        request.projectId,
        request.stepKey,
        request.reservationKey,
        request.estimatedMicrodollars,
        request.workflowLimitMicrodollars,
        request.dailyLimitMicrodollars,
        request.admissionNumerator,
        request.admissionDenominator,
        request.now,
        request.leaseExpiresAt,
        request.deploymentDailyLimitMicrodollars ?? 0,
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

  async settleSession(request: WorkflowSessionSettlement): Promise<
    | { readonly settled: true }
    | {
        readonly settled: false;
        readonly reason: 'workflow_budget' | 'daily_budget';
      }
  > {
    const rows = await this.sql.execute(
      `select "agentos_settle_workflow_session"($1, $2, $3, $4::bigint, $5::bigint, $6::bigint, $7::timestamptz) as "settled"`,
      [
        request.reservationKey,
        request.runId,
        request.stepKey,
        request.actualMicrodollars,
        request.workflowLimitMicrodollars,
        request.dailyLimitMicrodollars,
        request.now,
      ],
    );
    const result = String(rows[0]?.settled);
    if (result === 'settled') return { settled: true };
    if (result === 'workflow_budget' || result === 'daily_budget')
      return { settled: false, reason: result };
    else
      throw new WorkflowCheckpointConflictError(
        `workflow reservation ${request.reservationKey} cannot be settled`,
      );
  }

  async releaseSession(
    projectId: string,
    runId: string,
    stepKey: string,
  ): Promise<void> {
    await this.sql.execute(
      `delete from "workflow_session_leases"
       where "lease_key" = $3 and "run_id" = $1 and "step_key" = $2`,
      [runId, stepKey, `agent-session:${projectId}`],
    );
  }

  async listExpiredReservations(runId: string, now: string) {
    const rows = await this.sql.execute(
      `select "reservation_key" as "reservationKey", "project_id" as "projectId",
        "run_id" as "runId", "step_key" as "stepKey",
        "estimated_microdollars" as "estimatedMicrodollars",
        to_char("expires_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt"
       from "workflow_budget_reservations"
       where "run_id" = $1 and "expires_at" <= $2::timestamptz
       order by "reservation_key" collate "C" limit 1000`,
      [runId, now],
    );
    return rows.map((row) => ({
      reservationKey: String(row.reservationKey),
      projectId: String(row.projectId),
      runId: String(row.runId),
      stepKey: String(row.stepKey),
      estimatedMicrodollars: Number(row.estimatedMicrodollars),
      expiresAt: String(row.expiresAt),
    }));
  }

  async releaseRunForResume(runId: string): Promise<{ released: number }> {
    const rows = await this.sql.execute(
      `delete from "workflow_effects"
       where "run_id" = $1 and "status" <> 'succeeded'
       returning "effect_key"`,
      [runId],
    );
    // A reservation or lease left behind by a crash keeps counting against the
    // project's budget and its one-session-at-a-time gate, so a resume that
    // did not clear them would be refused before it ran anything.
    await this.sql.execute(
      `delete from "workflow_budget_reservations" where "run_id" = $1`,
      [runId],
    );
    await this.sql.execute(
      `delete from "workflow_session_leases" where "run_id" = $1`,
      [runId],
    );
    return { released: rows.length };
  }

  async #require(key: string): Promise<WorkflowEffect> {
    const value = await this.getEffect(key);
    if (value === undefined)
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${key} does not exist`,
      );
    return value;
  }

  async #owned(lease: WorkflowEffectLease): Promise<WorkflowEffect> {
    const value = await this.#require(lease.key);
    if (
      value.ownerId !== lease.ownerId ||
      value.leaseVersion !== lease.leaseVersion
    )
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${lease.key} fencing lease is not owned`,
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
