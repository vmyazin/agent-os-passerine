# Usage Settlement Retry Design

Status: Approved design

## Follow-up decision — 2026-08-26

The second live run exposed an earlier ordering defect: preparation can fail before the pending step row is persisted, but failure settlement still references that step from `usage_records`. The foreign key then rejects the usage write and masks the primary preparation error. Persist the pending step before claiming effects or performing fallible preparation. This extends the implementation boundary below; it does not change step semantics or retry limits.

## Context

The first live Agent OS run successfully ingested the repaired 7.5 MB source snapshot and reached the specification model. It then failed while persisting usage. The usage row exists, which proves the database committed the write but the caller did not receive a successful result. Replaying the same idempotent write succeeds.

The workflow already gives runtime steps two attempts, but usage settlement is part of the paid-session boundary. Retrying the whole agent step would spend money again when only the usage receipt is uncertain.

## Goals

- Retry a transient or ambiguously committed usage write in place.
- Reuse one immutable usage payload and idempotency key across every write attempt.
- Fail immediately for permanent persistence errors.
- Bound usage-write attempts at two total attempts.
- Preserve the existing two-attempt runtime-step policy and its visible step-run history.

## Non-goals

- Do not change workflow, daily, or deployment budget limits.
- Do not change runtime provider retry policy.
- Do not add a generic database retry framework.
- Do not retry idempotency conflicts or constraint violations.
- Do not redesign the run UI in this slice.

## Scope and implementation boundary

The production change lives inside `packages/adapters/src/trigger/workflow.ts`, in the usage-recording path owned by `runAgentStep`. It may add a small bounded cause-chain classifier local to that module. Tests live in `packages/adapters/src/trigger/workflow.test.ts`.

`runAgentStep` must also upsert the pending step before its first fallible effect or runtime-preparation operation so usage settlement always has a valid foreign-key target and the original error remains observable.

The implementation must not modify persistence schemas, migrations, pricing, repository contracts, Trigger task configuration, control-plane routes, or runtime adapters.

## Behavior

1. Build the usage record once after the provider session finishes.
2. Attempt the idempotent append.
3. If the error or a bounded nested cause identifies a transient transport/service condition, retry the identical record once.
4. If the second attempt fails, fail the run visibly without starting another agent session for that settlement.
5. If the first failure is permanent, fail immediately.

## Acceptance criteria

- A simulated response-loss error that commits the first append but exposes nested `ECONNRESET` succeeds on the second append.
- The retry does not start a second paid agent session.
- Both append calls receive identical usage payloads, including `recordedAt`.
- A permanent append error is attempted once and fails the run.
- A preparation failure before runtime start records zero usage against an existing pending step and surfaces the preparation failure, not a usage foreign-key error.
- Existing transient runtime failures still use the existing two-attempt step policy.
