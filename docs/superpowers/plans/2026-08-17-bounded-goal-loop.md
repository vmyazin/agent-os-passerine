# Bounded Goal Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, trusted goal workflow that delegates at most three attempts to the existing feature workflow and exposes replayable progress.

**Architecture:** A pure core reducer owns the three-step invariant. Persistence records immutable criteria and idempotent per-step progress. A Trigger goal task composes a narrow feature-step runner and a signed command-evidence verifier; the control plane treats pending goal runs as durable outbox intents.

**Tech Stack:** TypeScript 6, Zod 4, Vitest, Drizzle/PostgreSQL, Trigger.dev v4, Next.js, pnpm/Turborepo.

---

### Task 1: Configuration cap and pure goal reducer

**Files:**

- Create: `packages/core/src/goal-workflow.ts`
- Create: `packages/core/src/goal-workflow.test.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/config.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `agentos/example.yaml`
- Modify: `apps/cli/src/config-files.ts`

- [ ] **Step 1: Write failing reducer and configuration tests**

Add tests that require `goals.maxSteps` to accept 1–3 and reject 4, create a
goal state with immutable command criteria, ignore an exact duplicate event,
reject a conflicting duplicate, succeed when all criteria pass, advance after
an unsatisfied step, report `stuck` after the same signed failure occurs three
times, and report `step_limit` after the third distinct failure.

- [ ] **Step 2: Verify the tests fail for the missing reducer and unbounded schema**

Run: `pnpm --filter @agentos/core test -- src/goal-workflow.test.ts src/config.test.ts`

Expected: FAIL because `goal-workflow.js` does not exist and `maxSteps: 4` is
currently accepted.

- [ ] **Step 3: Implement the minimal reducer and cap**

Export `GoalWorkflowState`, `GoalWorkflowEvent`, `createGoalWorkflow`,
`reduceGoalWorkflow`, and `replayGoalWorkflow`. Constrain `GoalLimitsSchema`
with `PositiveInteger.max(3)` and change checked-in starter values from 20 to 3.
Use canonical SHA-256 event fingerprints and `detectStuck`.

- [ ] **Step 4: Verify core tests and commit**

Run: `pnpm --filter @agentos/core test`

Expected: all core tests pass.

Commit: `feat: add bounded goal state machine`

### Task 2: Goal provenance and durable criterion/progress records

**Files:**

- Modify: `packages/core/src/persistence.ts`
- Modify: `packages/adapters/src/persistence/schema.ts`
- Modify: `packages/adapters/src/persistence/validation.ts`
- Modify: `packages/adapters/src/persistence/in-memory.ts`
- Modify: `packages/adapters/src/persistence/neon-repository.ts`
- Modify: `packages/adapters/src/persistence/row-mapping.ts`
- Modify: `packages/adapters/src/persistence/repository-parity-contract.ts`
- Modify: `packages/adapters/src/persistence/postgres.integration.test.ts`
- Modify: `packages/adapters/src/persistence/schema.test.ts`
- Create: generated Drizzle migration and metadata
- Modify: `apps/control-plane/src/http/contracts.ts`
- Modify: `apps/control-plane/src/application/control-plane-service.ts`
- Modify: `apps/control-plane/src/application/control-plane-service.test.ts`
- Modify: `apps/control-plane/app/api/goals/route.ts`

- [ ] **Step 1: Write failing persistence and service tests**

Require canonical criterion definitions, step ordinals 1–3, idempotent replay,
conflict rejection, goal provenance mismatch rejection, one config snapshot,
deterministic criteria, and dispatch only after the snapshot/criteria set is
complete.

- [ ] **Step 2: Verify the focused tests fail**

Run: `pnpm --filter @agentos/adapters test -- src/persistence/repository-parity-contract.test.ts src/persistence/schema.test.ts && pnpm --filter @agentos/control-plane test -- src/application/control-plane-service.test.ts`

Expected: FAIL on absent definition/step fields, idempotent methods, and goal
snapshot behavior.

- [ ] **Step 3: Implement records, migration, and goal creation**

Add `definition: JsonValue` to `GoalCriterion`, `step: number` to
`GoalProgress`, and `createGoalCriterionIdempotently` plus
`appendGoalProgressIdempotently` to `DomainRepository`. Add Drizzle columns and
checks, generate the migration with `pnpm db:generate`, and implement parity in
both repositories. Introduce a strict command-criterion goal schema. Store the
criteria in immutable run input, bind goals to an applied config revision,
create one snapshot, create deterministic criteria, and request goal dispatch.

- [ ] **Step 4: Verify persistence/control-plane suites and commit**

Run: `pnpm --filter @agentos/adapters test && pnpm --filter @agentos/control-plane test`

Expected: all adapter and control-plane tests pass; PostgreSQL tests skip only
when `TEST_DATABASE_URL` is absent.

Commit: `feat: persist trusted goal criteria and progress`

### Task 3: Signed command evidence verifier

**Files:**

- Create: `packages/adapters/src/trigger/goal-verifier.ts`
- Create: `packages/adapters/src/trigger/goal-verifier.test.ts`
- Modify: `packages/adapters/src/trigger/index.ts`

- [ ] **Step 1: Write failing verifier tests**

Cover a valid signed trusted-test report and failures for a forged signature,
wrong child run, wrong subject/digest, wrong command, nonzero exit, reversed
timestamps, malformed report, and a DoD attestation replayed as a test report.

- [ ] **Step 2: Verify the tests fail because the verifier is absent**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/goal-verifier.test.ts`

Expected: FAIL resolving `goal-verifier.js`.

- [ ] **Step 3: Implement report verification and DoD attestation issuance**

Create `createTrustedGoalCommandVerifier` with separate
`trusted-test-report` and `definition-of-done-verification` HMAC authorities.
Parse bounded JSON, recompute canonical evidence digests, validate every run,
criterion, command, exit, and timestamp binding, then return the signed DoD
attestation required by core `verifyCriterion`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/goal-verifier.test.ts`

Expected: all goal-verifier tests pass.

Commit: `feat: verify signed goal command evidence`

### Task 4: Durable goal workflow and feature-step runner

**Files:**

- Create: `packages/adapters/src/trigger/goal-workflow.ts`
- Create: `packages/adapters/src/trigger/goal-workflow.test.ts`
- Create: `packages/adapters/src/trigger/goal-feature-runner.ts`
- Create: `packages/adapters/src/trigger/goal-feature-runner.test.ts`
- Modify: `packages/adapters/src/trigger/types.ts`
- Modify: `packages/adapters/src/trigger/index.ts`

- [ ] **Step 1: Write failing durable-workflow tests**

Require snapshot/criteria validation, deterministic child IDs, source-bundle
copying, terminal child replay, signed evidence evaluation, criterion progress,
success after one passing step, bounded retry, no fourth child, stuck detection,
parent cancellation checks, and sanitized terminal output.

- [ ] **Step 2: Verify the focused tests fail**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/goal-workflow.test.ts src/trigger/goal-feature-runner.test.ts`

Expected: FAIL because neither workflow nor runner exists.

- [ ] **Step 3: Implement the narrow ports and replay-safe workflow**

Add `GoalStepRunner`, `GoalStepResult`, and `DurableGoalWorkflowDependencies`.
Implement `createDurableGoalWorkflow` by reconstructing reducer state from
progress, checkpointing each child before execution, verifying every criterion,
and CAS-transitioning the parent. Implement `createFeatureGoalStepRunner` by
creating the deterministic child feature run/snapshot, copying the source
bundle, invoking `FeatureWorkflowTaskHandler`, and returning the child report as
submitted evidence.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/goal-workflow.test.ts src/trigger/goal-feature-runner.test.ts`

Expected: all goal workflow and runner tests pass.

Commit: `feat: coordinate durable goal attempts`

### Task 5: Trigger task, outbox, production composition, and reconciliation

**Files:**

- Create: `packages/adapters/src/trigger/goal-task-handler.ts`
- Create: `packages/adapters/src/trigger/goal-task-handler.test.ts`
- Create: `packages/adapters/src/trigger/goal-task.ts`
- Create: `packages/adapters/src/trigger/goal-production-composition.ts`
- Create: `packages/adapters/src/trigger/goal-production-handler.ts`
- Modify: `packages/adapters/src/trigger/trigger-adapter.ts`
- Modify: `packages/adapters/src/trigger/trigger-adapter.test.ts`
- Modify: `packages/adapters/src/trigger/outbox.ts`
- Modify: `packages/adapters/src/trigger/outbox.test.ts`
- Modify: `apps/control-plane/src/application/runtime.ts`
- Modify: `apps/control-plane/src/application/workflow-reconciliation.ts`
- Modify: `apps/control-plane/src/application/workflow-reconciliation.test.ts`

- [ ] **Step 1: Write failing dispatch/composition/reconciliation tests**

Require pipeline-bound start fingerprints, goal task dispatch, fail-closed goal
payload/snapshot validation, pending-goal redelivery only after snapshot and
criteria repair, deadline failure, terminal cleanup, and child cancellation.

- [ ] **Step 2: Verify the focused tests fail**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/trigger-adapter.test.ts src/trigger/outbox.test.ts src/trigger/goal-task-handler.test.ts && pnpm --filter @agentos/control-plane test -- src/application/workflow-reconciliation.test.ts`

Expected: FAIL because pipeline dispatch and goal composition are absent.

- [ ] **Step 3: Implement goal task registration and production wiring**

Add `agentos-goal-workflow-v1`, `startGoal`, and a pipeline field on start
requests. Extend trusted source ingestion to goal runs. Build a lazy production
goal handler using Neon, R2, the rotating test-report keys, the durable goal
workflow, and the existing production feature handler. Extend reconciliation
for pending/deadline/terminal goal runs and recorded child cancellation.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @agentos/adapters test && pnpm --filter @agentos/control-plane test`

Expected: all adapter/control-plane tests pass.

Commit: `feat: dispatch durable goal workflows`

### Task 6: Goal projection and CLI parity

**Files:**

- Modify: `apps/control-plane/src/application/control-plane-service.ts`
- Modify: `apps/control-plane/src/application/control-plane-service.test.ts`
- Modify: `apps/control-plane/src/http/contracts.ts`
- Modify: `apps/control-plane/src/application/run-page-model.ts`
- Modify: `apps/control-plane/src/application/run-page-model.test.ts`
- Modify: `apps/control-plane/app/runs/[id]/page.tsx`
- Modify: `apps/cli/src/types.ts`
- Modify: `apps/cli/src/args.ts`
- Modify: `apps/cli/src/args.test.ts`
- Modify: `apps/cli/src/commands.ts`
- Modify: `apps/cli/src/commands.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/output.ts`
- Modify: `apps/cli/src/output.test.ts`

- [ ] **Step 1: Write failing projection and CLI tests**

Require bounded criteria/latest-result/steps/child summaries, no raw report or
attestation leakage, `--criteria-json` parsing for goal start, rejection on
feature start, `goal show`, and readable text plus stable JSON output.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm --filter @agentos/control-plane test -- src/application/control-plane-service.test.ts src/application/run-page-model.test.ts && pnpm --filter @agentos/cli test`

Expected: FAIL on absent goal projection and CLI contracts.

- [ ] **Step 3: Implement the sanitized read model and CLI commands**

Project goal state from criteria/progress with bounded fields only. Render it on
the run page. Split feature/goal start option types, parse strict criteria JSON,
send it only to `/api/goals`, and map `goal show` to the existing run endpoint.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @agentos/control-plane test && pnpm --filter @agentos/cli test`

Expected: all delivery-surface tests pass.

Commit: `feat: expose bounded goal progress`

### Task 7: Documentation, generated artifacts, full verification, and review

**Files:**

- Create: `docs/architecture/durable-goal-workflow.md`
- Modify: `docs/architecture/README.md`
- Modify: `docs/progress.md`
- Modify: generated Drizzle metadata if required

- [ ] **Step 1: Document invariants and operational gates**

Describe the three-step cap, immutable provenance, signed command evidence,
child cancellation, replay model, required environment values, and no-cost/live
verification boundary. Mark only implemented product stages complete.

- [ ] **Step 2: Run formatting and schema checks**

Run: `pnpm format:check && pnpm db:check`

Expected: both exit zero.

- [ ] **Step 3: Run the complete no-cost verification matrix**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e`

Expected: every command exits zero. PostgreSQL integration is additionally run
with `pnpm test:integration` when `TEST_DATABASE_URL` is present.

- [ ] **Step 4: Audit requirements and request final code review**

Check every design requirement against code/tests, inspect `git diff --check`,
and review the complete branch diff from its merge base. Fix all critical and
important findings, then rerun affected tests and the full matrix.

- [ ] **Step 5: Commit final documentation/verification changes**

Commit: `docs: record bounded goal workflow`
