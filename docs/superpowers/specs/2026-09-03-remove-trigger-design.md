# Remove Trigger.dev

Status: Approved design (operator decision 2026-09-03, over a recommendation to
keep it)
Date: 2026-09-03
Approach: keep the ports, delete the one implementation behind them

## Context

Trigger.dev coordinates runs in this system, and three files import its SDK:
`trigger/task.ts`, `trigger/goal-task.ts`, `trigger/trigger-adapter.ts`.
Everything else — the workflow engine, the outbox, the checkpoint store, the
budget admission — is executor-agnostic and authoritative in Postgres. The
runbook already says the waitpoint is "only a wake signal": after waking, the
workflow re-reads the decision from the database.

The local executor added on 2026-09-02 replaced all three with an in-process
dispatcher, a database-polling approval waiter, and a composition profile. It
has since delivered four features end to end.

What Trigger cost, from this repository's own record: four days in which every
run was enqueued, reported as dispatched, and never executed, because dispatch
named a queue no task declared; a `wait.forToken` called outside a task; a
`dispatch_executor_unavailable`; and a run page that could only say "what
happened is visible in Trigger" on a deployment that has no Trigger in it.

The operator was advised to keep it for a possible unattended deployment and
decided to remove it. This records that decision and its cost.

## Goal

No `@trigger.dev` dependency, no Trigger configuration, no Trigger environment
variables, and one execution path: the local executor. Every guarantee that
currently holds keeps holding, because none of them were Trigger's.

## Non-goals

- Removing Managed Agents, R2, the artifact MCP, or the GitHub publisher.
  Those are runtime and storage choices, independent of who schedules a run,
  and the draft pull request is the product's stated output. The composition
  profile keeps selecting between them.
- Renaming the `trigger/` directory or the `DurableTriggerOutbox`,
  `TriggerWorkflowDispatcher` and `TriggerApprovalWaiter` identifiers. That is
  a mechanical rename across 44 files and every import that names them; it is
  worth doing, and it is worth doing on its own so this diff stays reviewable.
  Recorded as the follow-up below.
- Changing the workflow engine, the checkpoint store, budgets, sealing,
  verification, or publication.

## Design

### What is deleted

- `packages/adapters/src/trigger/task.ts`, `goal-task.ts`,
  `trigger-adapter.ts` and their tests — the only SDK importers.
- `trigger.config.ts`.
- `packages/adapters/scripts/trigger-dispatch-smoke.mjs` and its
  `smoke:trigger-dispatch` script — it exists to prove a dispatched run
  reaches a Trigger worker.
- `@trigger.dev/sdk` and `trigger.dev` devDependencies; the `trigger:dev` and
  `trigger:deploy` scripts.
- `TRIGGER_SECRET_KEY` and `TRIGGER_PROJECT_REF` from `.env.example`,
  readiness, and the executor switch.
- `AGENTOS_EXECUTOR`: with one executor there is nothing to select. Its
  boot-time mutual-exclusion check goes with it.

### What moves rather than dies

Three types live in the deleted files and are used by code that has no
business knowing about Trigger. They move to `trigger/types.ts`, which imports
no SDK, keeping their names for now (see the follow-up):

- `FeatureWorkflowTaskHandler` — `{ run(payload, execution) }`, used by both
  compositions and the local dispatcher.
- `TriggerWorkflowDispatcher` — the four-method executor port
  (`startFeature`, `startGoal`, `retrieve`, `cancel`).
- `TriggerApprovalWaiter` — `WorkflowApprovalWaiter` plus `wake(id)`.

`GoalWorkflowTaskHandler` moves the same way for the goal path.

### Executor status

`retrieve` currently returns Trigger's status vocabulary, and
`isExecutorUnavailable` in the outbox recognises `SYSTEM_FAILURE` plus an
error containing `COULD_NOT_FIND_EXECUTOR`. The local dispatcher was written
to satisfy that contract literally. With Trigger gone the vocabulary becomes
the local one — `EXECUTING`, `COMPLETED`, `FAILED`, `LOST` — and the outbox
recognises `LOST` and `FAILED` as "this executor no longer has it". The run
page's diagnosis, which already maps these, drops its Trigger-only branches
(`PENDING_VERSION`, `QUEUED`, `EXPIRED`, `DELAYED`, `CRASHED`, `TIMED_OUT`).

### Operator surface

`UndispatchedRunNotice` loses its Trigger variant. Readiness loses its
`dispatch` group. The setup wizard's "connect a Trigger.dev worker" notice
goes with it. Nothing else in the UI changes: the run page already speaks in
executor-neutral terms as of this morning.

### What does not change

Postgres stays authoritative. `workflow_effects` with its fencing leases is
still what makes a run replayable, the approval is still re-read from the
database after a wake, budget admission is still the plpgsql function, and
the two Vercel cron entries — reconciliation and artifact cleanup — are
unaffected because they were never Trigger's.

## Consequences the operator is accepting

- **No unattended execution.** A run executes inside the control plane. Close
  it mid-run and that run is lost; recovery re-dispatches it on the next
  start, replaying finished steps and re-running the interrupted one, so one
  step is paid for twice.
- **No scale-out.** One process, one machine.
- **A long approval needs the app running**, or the run is recovered and
  replays to the approval when it comes back.

All three were true of the local executor already; removing Trigger makes
them the only option rather than a choice.

## Testing

The suites are already executor-agnostic: the workflow tests drive
`createDurableFeatureWorkflow` directly, and the outbox tests use a fake
dispatcher. What changes is the deletion of `trigger-adapter.test.ts` and
`task-source.test.ts`, and the executor-selection tests losing their
mutual-exclusion cases. Everything else must pass unchanged, which is the
point: if removing Trigger breaks a guarantee, a test that never mentioned
Trigger will say so.

Live gate: a feature run end to end on the fixture project after the removal.

## Follow-up

Rename `packages/adapters/src/trigger/` to `workflow/`, and
`DurableTriggerOutbox`/`TriggerWorkflowDispatcher`/`TriggerApprovalWaiter` to
executor-neutral names. Mechanical, large, and safer as its own change.
