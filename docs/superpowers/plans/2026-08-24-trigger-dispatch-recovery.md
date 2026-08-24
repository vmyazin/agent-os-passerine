# Trigger Dispatch Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover exactly one Trigger handoff lost to `COULD_NOT_FIND_EXECUTOR`, then fail the domain run explicitly if the fresh handoff has the same confirmed pre-execution failure.

**Architecture:** The Trigger dispatcher exposes best-effort external state and attempt-aware idempotency. The durable outbox treats primary and retry handoffs as separate effects, while cancellation and diagnostics consume the complete attempt history.

**Tech Stack:** TypeScript, Vitest, Trigger.dev SDK boundary, durable workflow checkpoint store

---

## File map

- `packages/adapters/src/trigger/trigger-adapter.ts:117-161` — attempt-aware start keys and read-only external state.
- `packages/adapters/src/trigger/trigger-adapter.test.ts:39-104` — preserve primary keys and prove distinct retry keys/status lookup.
- `packages/adapters/src/trigger/outbox.ts:242-309,431-464` — reconcile confirmed executor loss, fence one retry, terminate a repeated loss, and cancel all attempts.
- `packages/adapters/src/trigger/outbox.test.ts:18-414` — exact recovery, negative statuses, terminal failure, replay, and multi-attempt cancellation.
- `apps/control-plane/src/application/run-page-model.ts:51-95` — query the newest Trigger attempt.
- `apps/control-plane/src/application/run-page-model.test.ts:1-33` — prove newest-reference selection.

## Do not modify

- Runtime-session recovery or model session retry behavior.
- Trigger task declarations, queue/concurrency configuration, task bodies, or runtime/model routing.
- Approval waits, source ingestion, publication, or database schema.
- Any run whose Trigger status is unknown or whose failure is not the exact executor-loss signature.

### Task 1: Dispatcher attempt and status contract

**Files:**

- Modify: `packages/adapters/src/trigger/trigger-adapter.test.ts:39-104`
- Modify: `packages/adapters/src/trigger/trigger-adapter.ts:117-161`

- [x] **Step 1: Write failing dispatcher tests**

Keep the current two-argument call assertions, then add attempt 1:

```ts
await dispatcher.startFeature('run-1', 'project-1', 1);
expect(calls.at(-1)?.args[2]).toEqual(
  expect.objectContaining({
    idempotencyKey: 'feature-workflow:run-1:v1:retry:1',
  }),
);
await expect(dispatcher.retrieve('trigger-run-safe-ref')).resolves.toEqual({
  status: 'QUEUED',
});
```

Add the equivalent goal retry key assertion.

- [x] **Step 2: Run and verify RED**

Run: `pnpm --filter @agentos/adapters test -- trigger-adapter.test.ts`

Expected: FAIL because starts do not accept an attempt and the dispatcher has no `retrieve` method.

- [x] **Step 3: Implement the dispatcher contract**

Add optional `attempt: 0 | 1 = 0` parameters, append `:retry:1` only for attempt 1, and expose `retrieve(externalRunRef)` by delegating to the existing best-effort SDK `retrieveRun`. Preserve attempt-0 keys byte-for-byte.

- [x] **Step 4: Run and verify GREEN**

Run: `pnpm --filter @agentos/adapters test -- trigger-adapter.test.ts`

Expected: PASS.

### Task 2: One durable recovery and explicit second-failure termination

**Files:**

- Modify: `packages/adapters/src/trigger/outbox.test.ts:18-322`
- Modify: `packages/adapters/src/trigger/outbox.ts:217-309`

- [x] **Step 1: Write the failing exact-recovery tests**

Create a real in-memory repository run and a fake dispatcher whose primary lookup returns `{ status: 'SYSTEM_FAILURE', error: 'COULD_NOT_FIND_EXECUTOR' }`. Call `requestStart` repeatedly and assert one attempt-1 dispatch, one succeeded `workflow-start:<runId>:retry:1` effect, and no duplicates.

- [x] **Step 2: Write the failing negative-state table**

For `undefined`, `QUEUED`, `EXECUTING`, `FAILED`, and `{ status: 'SYSTEM_FAILURE', error: 'different failure' }`, assert no retry effect and no attempt-1 start.

- [x] **Step 3: Write the failing repeated-loss test**

Return the exact failure for both persisted external references and assert the repository run becomes:

```ts
{
  status: 'failed',
  error: { code: 'dispatch_executor_unavailable' },
  output: { status: 'failed', reason: 'dispatch_executor_unavailable' },
}
```

Repeated reconciliation must not transition or dispatch again.

- [x] **Step 4: Run and verify RED**

Run: `pnpm --filter @agentos/adapters test -- outbox.test.ts`

Expected: FAIL because a succeeded start effect currently returns without external reconciliation.

- [x] **Step 5: Implement the minimal recovery state machine**

Add a predicate requiring both `SYSTEM_FAILURE` and `COULD_NOT_FIND_EXECUTOR`. After source ingestion, inspect primary and retry effects in order. Unknown/nonmatching state returns. The first exact failure claims `${request.idempotencyKey}:retry:1`, dispatches with attempt `1`, attaches/completes that effect, and returns. A second exact failure transitions only `pending`, `running`, or `waiting` with the current state version and stable failure code/output.

- [x] **Step 6: Run and verify GREEN**

Run: `pnpm --filter @agentos/adapters test -- outbox.test.ts`

Expected: PASS.

### Task 3: Multi-attempt cancellation

**Files:**

- Modify: `packages/adapters/src/trigger/outbox.test.ts:324-414`
- Modify: `packages/adapters/src/trigger/outbox.ts:431-464`

- [x] **Step 1: Write the failing cancellation test**

Seed primary and retry start effects with distinct external references. Assert cancellation receives both references once, duplicate references are de-duplicated, and replay does not repeat successful cancellations.

- [x] **Step 2: Run and verify RED**

Run: `pnpm --filter @agentos/adapters test -- outbox.test.ts`

Expected: FAIL because cancellation currently selects the first start effect only.

- [x] **Step 3: Cancel every distinct persisted start**

Build an ordered `Set` of Trigger start references. Preserve `${request.idempotencyKey}:trigger` for the first attempt and use `${request.idempotencyKey}:trigger:<externalRef>` for later attempts so each cancellation is independently durable.

- [x] **Step 4: Run and verify GREEN**

Run: `pnpm --filter @agentos/adapters test -- outbox.test.ts`

Expected: PASS.

### Task 4: Newest-attempt diagnostics

**Files:**

- Modify: `apps/control-plane/src/application/run-page-model.test.ts:1-33`
- Modify: `apps/control-plane/src/application/run-page-model.ts:51-95`

- [x] **Step 1: Write the failing newest-reference test**

Inject or mock two ordered dispatch records, primary then retry, and assert the external state loader receives only the retry reference.

- [x] **Step 2: Run and verify RED**

Run: `pnpm --filter @agentos/control-plane test -- run-page-model.test.ts`

Expected: FAIL because `loadRunDispatch` uses `find` and therefore selects the primary reference.

- [x] **Step 3: Select the newest persisted reference**

Choose the last Trigger start record with an external reference while preserving the full record list for operator diagnostics and the existing fail-soft behavior.

- [x] **Step 4: Run and verify GREEN**

Run: `pnpm --filter @agentos/control-plane test -- run-page-model.test.ts`

Expected: PASS.

- [x] **Step 5: Verify the complete dispatch change**

Run: `pnpm --filter @agentos/adapters test -- trigger-adapter.test.ts outbox.test.ts && pnpm --filter @agentos/adapters typecheck && pnpm --filter @agentos/control-plane test -- run-page-model.test.ts && pnpm --filter @agentos/control-plane typecheck`

Expected: every command exits 0. Do not commit; the user did not authorize commits.
