# Trigger pre-execution dispatch recovery

Status: Approved design

## Context

Trigger.dev development workers rebuild when the watched checkout changes. A task
dispatched during that interval can be accepted by Trigger and immediately finish as
`SYSTEM_FAILURE` with `COULD_NOT_FIND_EXECUTOR`. The durable start effect currently
becomes `succeeded` as soon as Trigger returns a run id. Every later reconciliation
therefore treats the handoff as complete even though the external run never executed,
leaving the Agent OS run `pending` until its workflow deadline.

Live evidence on 2026-08-24 reproduced the boundary: two paid feature dispatches
failed before task execution, while the same worker version dequeued the dispatch
smoke test. Once the worker stabilized, the smoke test also dequeued with the affected
project's real concurrency key. This rules out the declared queue and concurrency key
and isolates the rebuild window plus missing post-dispatch recovery.

## Goals

- Recover one feature or goal dispatch automatically when Trigger reports exactly the
  known pre-execution failure: status `SYSTEM_FAILURE` and an error containing
  `COULD_NOT_FIND_EXECUTOR`.
- Persist the retry as a separate fenced workflow effect and use a new Trigger
  idempotency key, so reconciliation and process crashes cannot create duplicate
  retries.
- If the one retry fails the same way, terminate the Agent OS run with a specific,
  operator-visible dispatch error instead of leaving it pending.
- Keep cancellation and run diagnostics pointed at every persisted Trigger attempt,
  especially the newest attempt.

## Non-goals

- Retrying a task that entered user code, emitted a step, or failed with any other
  Trigger status or error.
- General retries for `CRASHED`, `FAILED`, timeouts, network ambiguity, model errors,
  or workflow failures.
- Replacing the recommended operational isolation of running the dev worker from a
  checkout that is not being edited.
- Changing task queues, project concurrency, the workflow task body, or runtime/model
  retry policy.

## Scope and implementation boundary

The behavior lives inside the durable Trigger start boundary in
`packages/adapters/src/trigger/outbox.ts`. The dispatcher in
`packages/adapters/src/trigger/trigger-adapter.ts` gains two narrow capabilities:
read one external run's status, and derive a distinct idempotency key for retry attempt
1 while preserving the existing attempt-0 key byte-for-byte.

`requestStart` remains the only public start operation. It inspects the ordered
`trigger-workflow-start` effects for the run:

1. With no completed start, it performs the existing attempt 0.
2. With a completed attempt whose external state is not the exact retryable failure,
   it returns without changing anything.
3. With attempt 0 in the exact retryable state, it claims
   `workflow-start:<runId>:retry:1`, dispatches attempt 1, attaches the new external
   reference, and completes that effect.
4. With attempt 1 in the same retryable state, it transitions an active domain run to
   `failed` with code `dispatch_executor_unavailable` and a stable output reason.

Unknown external state is fail-soft and does not retry. This preserves the existing
behavior when the Trigger API is unavailable and avoids interpreting absence as proof
that execution never began.

Cancellation must signal every distinct persisted Trigger start reference, not the
first effect returned by key order. Diagnostics may display the attempt history but
must query the newest external reference when explaining current state.

Do not modify runtime-session recovery, model session retries, queue declarations,
approval waits, source ingestion, publication, or the database schema. Existing
workflow effects already accept string kinds and arbitrary deterministic keys, so no
migration is required.

## Data and failure flow

The primary and retry effects are immutable evidence of two separate handoffs. A
process crash before receiving Trigger's response replays the same attempt through its
same idempotency key. A confirmed `COULD_NOT_FIND_EXECUTOR` result advances to the next
attempt exactly once. A second confirmed result terminates the domain run. Any other
status stays authoritative and is never reinterpreted by this feature.

The domain transition uses the current run state version and only accepts
`pending`, `running`, or `waiting`, making repeated reconciliation harmless if the task
or operator already completed or cancelled the run.

## Verification

- A dispatcher unit test proves attempt 0 retains its current idempotency key and
  attempt 1 uses a different deterministic key.
- An outbox test starts with a succeeded attempt-0 effect whose external lookup
  returns the exact system failure, observes one retry, and proves repeated calls do
  not duplicate it.
- A second outbox test returns the same failure for attempt 1 and proves the domain
  run becomes `failed` with `dispatch_executor_unavailable`.
- Negative cases prove `undefined`, `QUEUED`, `EXECUTING`, `FAILED`, and other system
  errors do not retry.
- Cancellation and run-page tests prove multiple effects use all references for
  cancellation and the newest reference for diagnosis.
- The existing real Trigger dispatch smoke remains the live boundary check before any
  paid run.
