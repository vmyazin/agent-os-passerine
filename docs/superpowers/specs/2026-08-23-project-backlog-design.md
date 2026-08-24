# Project Backlog: Executing An Ordered List Of Features

Status: Draft design
Date: 2026-08-23
Approach: a durable, ordered list of feature requests per project; when one
item's run publishes, the next dispatches chained onto it — advanced by the
existing reconciliation loop, paused by anything that is not a clean success

## Context

With run chaining, feature N+1 can start from feature N's published commit.
Nothing starts it. Today the operator opens the run page, sees a success,
copies the run id, and issues the next `feature start` by hand — five times
for a five-feature body of work, each time re-supplying the project's
provenance digests.

That is the last purely mechanical step between "executes a feature" and
"executes a project". The parts it needs already exist: run creation is
idempotent and provenance-checked, the reconciliation loop already scans
every project's runs durably and resumably, chaining derives the base from a
run's own publication record, and approvals now wait 24 hours so a sequence
can span a night.

## Goal

The operator writes an ordered list of features once. The system runs them
one at a time, each chained onto the last, pausing for the spec/DoD approval
that each run already requires — and stopping cleanly the moment anything is
not a plain success.

## Non-goals

- **No agent decomposition in this slice.** An agent that turns a goal into
  a feature list is a separate, later producer *of* this list. Building the
  list and the executor at once would make a model call load-bearing in a
  mechanism that should be testable without one.
- **No auto-approval.** Each run still stops at its spec/DoD approval. The
  backlog removes the operator's *clerical* work, not their judgment.
- **No automatic merging**, ever. Merging stays the operator's release valve
  and is what unblocks a stack that hit its depth bound.
- **No parallel items.** One run in flight per backlog. Cross-*project*
  parallelism is unchanged.
- **No re-planning on failure.** A failed item pauses the backlog; the
  operator decides. Retry-with-modified-description is a later slice.
- Do not change chaining's five refusals, the frozen acceptance gate, budget
  admission, or approval semantics.

## Scope and implementation boundary

- Persistence: two tables (`backlogs`, `backlog_items`), both repository
  adapters, and parity contract cases.
- Service: create/list/pause/resume a backlog, and one `advanceBacklogs`
  routine that decides whether to dispatch the next item.
- Reconciliation: call `advanceBacklogs` in the existing scan, per project.
- Surface: API + CLI to create and inspect; the project page shows the list.

Must not touch: `dod.ts`, `acceptance-tests.ts`, `verification-policy.ts`,
publication HMAC, session leases, Trigger task IDs, budget admission SQL,
or the chain resolution added by the run-chaining slice.

## Concepts

**A backlog is an ordered list bound to a project.** Items carry a title, a
description, an ordinal, and a status (`pending`, `running`, `succeeded`,
`skipped`, `failed`). The backlog itself is `active`, `paused`, or
`completed`. Items are immutable once created except for status and the run
id they produced; reordering or editing is a later slice, and adding items
to the end of an `active` backlog is allowed.

**Advance is a pure decision over durable state.** Given a backlog, its
items, and the runs those items produced, `advanceBacklogs` answers one
question: *is there an item to dispatch right now, and on what base?* It
dispatches when every earlier item has succeeded, none is in flight, and the
previous item's run recorded a publication. Everything else pauses the
backlog with a reason. Keeping this a pure function over fetched state is
what makes the whole feature testable without a scheduler.

**The chain is the mechanism, and its bound is the release valve.** Item 1
runs unchained from the applied revision's SHA. Item N+1 chains onto item
N's run. When the chain reaches `config.chains.maxDepth`, the next dispatch
would fail `chain_too_deep`, so the backlog pauses with
`chain_depth_reached`: the stack is as deep as this project allows and the
operator merges to continue. That is not a workaround — an unmerged stack of
five features is five features' worth of conflict surface and review debt,
and the bound is where the operator said to stop.

**Pause is the only failure mode.** A run that fails, is rejected, expires,
is cancelled, or exhausts its budget pauses the backlog with that reason
recorded. A configuration applied mid-backlog surfaces as
`chain_configuration_changed` from run creation and pauses the same way. The
backlog never retries by itself, never skips an item to keep going, and
never dispatches past a non-success. Resuming is an explicit operator act.

**Advance is idempotent, like everything else it rides on.** The dispatch
uses a deterministic idempotency key (`backlog:<backlogId>:item:<ordinal>`),
so two reconciliation passes racing produce one run. The item records the
run id it produced; a pass that finds one never creates another.

## Slice 1 — Durable backlog and the advance decision

Tables:

```
backlogs(id, project_id, title, status, paused_reason, created_at, updated_at)
backlog_items(id, backlog_id, ordinal, title, description, status, run_id,
              created_at, updated_at)
unique(backlog_id, ordinal)
unique(run_id)                       -- one item per run
```

Port methods on `DomainRepository`: `createBacklog`,
`createBacklogItemIdempotently`, `getBacklog`, `listBacklogs(projectId)`,
`listBacklogItems(backlogId)`, `updateBacklogStatus` (CAS on status),
`attachBacklogItemRun` (CAS: item is `pending` and has no run).

`advanceBacklog(backlog, items, runs)` in core — pure, no I/O — returns one
of: `{ kind: 'idle' }`, `{ kind: 'dispatch', item, baseRunId? }`,
`{ kind: 'pause', reason }`, `{ kind: 'complete' }`. Its whole contract is a
table of cases, and its tests are that table.

**The migration must be registered in `drizzle/meta/_journal.json`.**
`pnpm db:check` cannot see an unregistered `.sql` file, so a migration that
is merely present is a migration that never runs.

## Slice 2 — Wiring and surface

- `reconcileWorkflowOutbox` calls the advance routine per project, after its
  existing run scan, inside the same bounded pagination.
- Dispatch resolves the project's latest applied revision for provenance and
  calls the existing `createFeatureRun` with `baseRunId` — no new creation
  path, so every chain refusal and provenance check applies unchanged. A
  `ServiceError` from creation pauses the backlog with its code as the
  reason.
- API: `POST /api/backlogs`, `GET /api/backlogs?projectId=`,
  `POST /api/backlogs/:id/pause|resume`. CLI: `backlog create --items-json`,
  `backlog show`.
- Project page: the ordered list with each item's status and a link to its
  run; the paused reason stated in words, with what to do about it.

## Verification

Credential-free:

- The advance table: empty backlog, first item, item after a success, item
  while one is in flight, item after each terminal non-success, a base that
  published nothing, depth bound reached, last item succeeded → complete.
- Idempotence: two advances over the same state dispatch once.
- Repository parity: both adapters agree on ordering, the two uniqueness
  constraints, and the CAS on `attachBacklogItemRun`.
- Integration (`TEST_DATABASE_URL`): the migration applies, and the journal
  entry exists — assert on the journal, since `db:check` cannot.
- End-to-end without agents: seed a backlog whose first item's run is marked
  succeeded with a publication, advance, and assert the second run exists
  with the right chain edge.

What this cannot prove without spending: a backlog driven by real agent
sessions from end to end. Say so in `docs/progress.md` rather than letting a
green suite imply it.

## Out of scope

Agent decomposition, reordering, editing an item, retry policy, parallel
items, cross-project backlogs, budgets scoped to a backlog, and any
automatic merge.
