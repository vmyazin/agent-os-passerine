# Project Backlog Implementation Plan

**Goal:** an ordered list of features per project that dispatches one run at
a time, each chained onto the last, and pauses on anything that is not a
clean success.

**Spec:** `docs/superpowers/specs/2026-08-23-project-backlog-design.md`

**Architecture:** the decision is a pure function in core over fetched
state; persistence holds the list; the existing reconciliation loop calls
the decision and dispatches through the existing `createFeatureRun`, so
every chain refusal and provenance check applies unchanged.

## Global constraints

- Do not modify `dod.ts`, `acceptance-tests.ts`, `verification-policy.ts`,
  publication HMAC, session leases, Trigger task IDs, budget admission SQL,
  or the chain resolution in `resolveChain`.
- No new run-creation path. The backlog calls `createFeatureRun`.
- Bounded pagination everywhere; no unbounded fan-out per reconciliation
  pass.
- The migration MUST be registered in `drizzle/meta/_journal.json`;
  `pnpm db:check` cannot detect an unregistered file.

## File map

| Path | Role |
| --- | --- |
| Create `packages/core/src/backlog.ts` | Types + pure `advanceBacklog` |
| Create `packages/core/src/backlog.test.ts` | The decision table |
| `packages/core/src/index.ts` | Export it |
| `packages/core/src/persistence.ts` | Id kinds + port methods |
| `packages/adapters/src/persistence/in-memory.ts` | In-memory adapter |
| `packages/adapters/src/persistence/neon-repository.ts` | Postgres adapter |
| `packages/adapters/src/persistence/repository-parity-contract.ts` | Parity cases |
| Create `drizzle/0021_project_backlogs.sql` + journal entry | Schema |
| `apps/control-plane/src/application/control-plane-service.ts` | create/list/pause/resume + `advanceBacklogs` |
| `apps/control-plane/src/application/workflow-reconciliation.ts` | Call it per project |
| `apps/control-plane/src/http/contracts.ts`, `app/api/backlogs/**` | API |
| `apps/cli/src/{args,commands,types}.ts` | `backlog create` / `backlog show` |
| `apps/control-plane/app/projects/[id]/page.tsx` | Render the list |
| `docs/architecture/durable-feature-workflow.md`, `docs/progress.md` | Docs |

## Tasks

### Task 1: The decision, as a pure function

- [ ] `Backlog`, `BacklogItem`, statuses, and `advanceBacklog(backlog,
      items, runs)` returning `idle` | `dispatch` | `pause` | `complete`.
- [ ] Tests are the case table from the spec: empty, first item, after a
      success, while one is in flight, after each terminal non-success, base
      published nothing, depth bound reached, all succeeded.
- [ ] Verify: `pnpm --filter @agentos/core test`

### Task 2: Persistence

- [ ] Id kinds `backlog` / `backlogItem`; port methods per the spec.
- [ ] Both adapters, then parity cases: ordering, `unique(backlog_id,
      ordinal)`, `unique(run_id)`, and the CAS on `attachBacklogItemRun`.
- [ ] `drizzle/0021_project_backlogs.sql` **and** its `_journal.json` entry.
- [ ] Verify: `pnpm --filter @agentos/adapters test`, and with
      `TEST_DATABASE_URL` when a database is available.

### Task 3: Service and reconciliation

- [ ] `createBacklog`, `listBacklogs`, `pauseBacklog`, `resumeBacklog`.
- [ ] `advanceBacklogs(projectId)`: fetch, decide, dispatch via
      `createFeatureRun` with the deterministic idempotency key, attach the
      run to the item, or pause with the reason. A `ServiceError` from
      creation pauses with its code.
- [ ] Reconciliation calls it per project inside the existing scan.
- [ ] Verify: `pnpm --filter @agentos/control-plane test`

### Task 4: Surface

- [ ] API routes + contracts (response schemas included — a projection
      field missing from a response schema is a 500 no service test sees).
- [ ] CLI `backlog create --items-json` / `backlog show`.
- [ ] Project page renders the ordered list, each item's status and run
      link, and the paused reason in words.
- [ ] Verify: `pnpm turbo run typecheck lint test`, then the page in a
      browser against seeded data.

### Task 5: Docs

- [ ] Architecture doc gains a Backlog section; `progress.md` records what
      is proved and states plainly that no backlog has been driven by real
      agent sessions.
