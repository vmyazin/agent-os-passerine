# Frozen Acceptance Tests as Definition of Done

Status: Approved design
Date: 2026-08-20
Approach: make DoD executable files the implementer cannot edit; split
approval wait from the execution clock so those files can be reviewed
overnight

## Context

A local-experiment feature run (`run_15719086586fdbaa2f3e8d1d5944c0cc` on
`todo-app-02`) published after specification, planning, implementation,
review, and sealed verification all reported success. The spec required a
deep defensive copy: mutating a todo returned by `list()` or `add()` must
not alter the store. The implementation returned the internal objects
(`list()` was `[...todos]`). The implementer's six tests passed. Two tests
written from the spec's own sentences failed.

The attestation chain worked. The DoD contract did not. Today's
`definition-of-done-v1` is prose plus `verifier: "test-report"`. Sealed
verification re-runs an allowlisted command and checks exit 0. The
implementer authors the tests that command runs. A green run means the
author's suite passed.

Approvals expire at `run.createdAt + FEATURE_WORKFLOW_DEFAULTS.workflowTimeoutMs`
(60 minutes), the same instant as the execution deadline. Missing that
window kills the work. That is incompatible with reviewing the actual
acceptance tests before implementation starts.

## Goal

A feature run cannot publish unless tests the implementer cannot edit have
passed in the sealed sandbox, and the operator has seen those test files
before implementation starts. Waiting for that look does not consume the
60-minute execution budget.

## Non-goals

- Do not retune `packages/core/src/dod.ts` or `verification-policy.ts`. The
  attestation, allowlist, and fingerprint machinery stays.
- Do not add a new test-author agent. The specifier writes the files.
- Do not give the specifier write, edit, or bash tools. Tests live in the
  DoD artifact.
- Do not auto-approve. The operator's look at the test files is
  load-bearing.
- Do not add a pre-implementation "red phase" session that runs the tests
  against source-only. It would catch tautologies, and it would also spend
  a verification-priced reservation against the $2 workflow cap. The inbox
  showing the file bodies is the tautology detector for this slice.
- Do not add cross-attempt failure memory, resume-from-step, or `npm run
  dev`. Those are real and out of this spec.
- Do not change goal-start command criteria. Operator-supplied allowlist
  keys on `POST /api/goals` stay. Feature-workflow children inherit frozen
  tests from their own specifier, the same as a directly started feature.
- Do not generalize the acceptance runner off Node. The POC already bakes
  `pnpm install --frozen-lockfile --ignore-scripts` into
  `exactTrustedCommand`; the acceptance suffix is the same class of
  trusted-code constant.

## Scope and implementation boundary

Two slices, one spec, because an overnight look at tests that are not a
gate is theatre, and a gate you must hit in 58 minutes is not
semi-autonomous.

**Slice 1 — Frozen tests.** Lives in the feature-workflow DoD schema, the
trusted seal of the change set, `exactTrustedCommand`, the specifier
prompt, and the approval inbox summary. Must not touch `dod.ts`,
publication HMAC, GitHub/local publisher internals, session leases, or
Trigger task IDs.

**Slice 2 — Approval wait vs execution clock.** Lives in
`FEATURE_WORKFLOW_DEFAULTS`, the feature-workflow deadline calculation, the
waitpoint timeout bound, and reconciliation. Must not change budget
admission, session timeout, or approval scope-hash semantics.

## Concepts

**Acceptance tests are the Definition of Done.** Each DoD criterion has
exactly one file at `test/acceptance/<criterionId>.test.mjs`. Those files
are written by the specifier into the hashed DoD artifact, shown to the
operator at the existing spec/DoD approval, overlaid by trusted code after
the implementer's change set, executed by a trusted-code suffix on the
sealed command, and published with the branch. The implementer cannot add,
modify, or delete any path under `test/acceptance/`.

**The implementer's own tests still run.** They are untrusted evidence that
the author believed the work was done. They are not the gate.

**Approval wait is not execution.** A run in `waiting` is allowed to sit
until its pending approval expires (24 hours). The 60-minute execution
clock starts when that approval is consumed. Auto-approval is rejected
because it would skip the look at the files.

## Slice 1 — Frozen acceptance tests

### Schema

`definition-of-done-v1` is no longer accepted by the feature workflow.
`parseArtifact(..., definitionOfDoneSchema)` fails closed on v1 so a
specifier that only writes prose cannot ship.

```json
{
  "version": "definition-of-done-v2",
  "criteria": [
    {
      "id": "list-deep-copy",
      "description": "Mutating a todo returned by list() does not change the store",
      "verifier": "test-report"
    }
  ],
  "acceptanceTests": [
    {
      "path": "test/acceptance/list-deep-copy.test.mjs",
      "mode": "100644",
      "content": "import { test } from 'node:test';\n..."
    }
  ]
}
```

Constraints, all schema-enforced:

- `criteria` remains 1–100 entries; `id` / `description` / `verifier:
  "test-report"` unchanged.
- `acceptanceTests` is 1–20 files.
- Every `criteria[].id` has exactly one file whose path is
  `test/acceptance/<id>.test.mjs`. Every file maps to a criterion. Extra
  or missing files fail the schema.
- Paths use the existing publication path rules (relative, no `..`, no
  NUL, printable ASCII, NFC) and must start with `test/acceptance/`
  (lowercase, exact prefix).
- `mode` is `100644` only. Content is UTF-8 text, no NUL, each file ≤
  `PUBLICATION_MAX_FILE_BYTES`, aggregate ≤ `PUBLICATION_MAX_TOTAL_BYTES`.

Put the 1:1 path rule and prefix check in
`packages/core/src/acceptance-tests.ts` so adapters schemas call one
function rather than duplicating globs. Do not fold this into `dod.ts`.

### Specifier

Keep the specifier without write/edit/bash. Update the prompt in
`agentos/passerine.yaml` and the generated
`apps/control-plane/src/ui/setup-template.ts` and
`setup-template-local.ts`:

- Write `definition-of-done-v2`.
- For each requirement, add one criterion and one `node:test` file that
  fails if that requirement is unmet. Include the negative cases the
  requirement names (mutation, missing ids, identity). Do not test only
  the half of a copy that is easy.

The planner prompt stays. The implementer prompt gains one sentence: do
not add, modify, or delete files under `test/acceptance/`; trusted code
will overlay them. The reviewer prompt: the DoD artifact now contains the
acceptance files; approve only if the change set would make those files
pass. Review remains advisory. The files are the gate.

### Seal

After the workflow parses the implementer (or fix) change set and the
already-parsed DoD, trusted code in
`packages/adapters/src/trigger/workflow.ts` calls
`sealChangeSet(changeSet, acceptanceTests)` from core:

1. If any implementer change path is under `test/acceptance/`
   (case-insensitive, same matcher style as publication protected paths),
   throw a permanent workflow error `acceptance_path_reserved`. Do not
   overlay over a colliding implementer file — fail so the implementer
   cannot smuggle a different suite onto the same path.
2. Append one `add` (or `modify` if the source bundle already has that
   path) per acceptance file. Source-bundle collisions are allowed: the
   frozen file wins. Implementer collisions are not.
3. Return the sealed change set. Re-validate with `changeSetSchema` and
   `evaluatePublicationPolicy` so overlay cannot exceed file-count or
   byte caps.

The implementer's original `changes` artifact stays for audit. Trusted
code writes a new artifact itself (`ArtifactStore.put`, not agent MCP):
`stepId: "implementation"` (or `"fix"`), `artifactId: "sealed-changes"`.
Verification and publication consume the sealed artifact and the sealed
in-memory object. `changeSetDigest` in the trusted command observation
binds the sealed set.

`createTrustedWorkflowVerifier` already parses `input.changeSet` and
evaluates publication policy. Pass it the sealed set. No verifier rewrite
beyond that input.

### Sealed command

`exactTrustedCommand` in
`packages/adapters/src/trigger/production-handler.ts` currently ends with
the allowlisted project invocation. Append a trusted-code suffix, the same
way install is already hardcoded:

```
… && ${invocation} && node --test test/acceptance/
```

The observation is still one command string and one exit code. Either
half failing fails verification. Do not take the acceptance runner from
the implementer's `package.json` test script — that is the evasion the
todo-store run demonstrated (`pnpm test` / `node --test test/` can be
narrowed to the author's files).

`MATERIALIZE_SCRIPT` stays source-then-changes. Because `changes.json` is
the sealed set, the acceptance files land in `/workspace/repo` after the
implementer's edits. Verification's `runtimeAccess.prepare` already remaps
the `changes` artifact to `/workspace/inputs/changes.json`; point that
remap at `sealed-changes`.

### Approval inbox

`ApprovalSummary` today is title, requirement strings, and criterion
descriptions (`control-plane-service.ts` `approvalSummary`, rendered in
`inbox-view.tsx`). Add `acceptanceTests: { path, content }[]`.

`approvalSummary` reads `dod.acceptanceTests`, redacts, and bounds each
body (8_000 characters, truncate with a visible ellipsis — fail-soft, same
as requirements). The inbox renders each file as path plus a `<pre>` body
above the existing "It counts as done when" list. Approving without
scrolling past the files is still possible; hiding them is not.

### What this would have done to the todo-store run

If the specifier had written the two mutation tests into
`test/acceptance/` as the schema now requires, sealed verification would
have failed, publication would not have run, and the inbox would have
shown those test bodies before implementation started. If the specifier
had written only the array-push test, the operator would have seen that
body at approval — the remaining hole, accepted for this slice, is a
specifier that writes shallow tests and an operator who approves them.

## Slice 2 — Approval wait vs execution clock

### Defaults

Extend `FEATURE_WORKFLOW_DEFAULTS` in
`packages/adapters/src/trigger/types.ts`:

```
approvalTtlMs: 24 * 60 * 60 * 1_000
workflowTimeoutMs: 60 * 60 * 1_000   // unchanged; meaning changes
```

`workflowTimeoutMs` is no longer "wall clock from `run.createdAt`,
including the approval wait." It is the execution budget after the
spec/DoD approval is consumed.

### Feature workflow

Today (`workflow.ts`):

- `deadlineMs = Date.parse(run.createdAt) + workflowTimeoutMs`
- approval `expiresAt` = that same instant
- waitpoint timeout = remaining seconds until that instant, rejected if
  outside `(0, workflowTimeoutMs]`

Change:

- Create the approval with `expiresAt = createdAt + approvalTtlMs`.
- Waitpoint timeout = remaining seconds until `expiresAt`, bounded by
  `approvalTtlMs` (update `triggerWaitDuration`).
- After the waitpoint, read the consumed approval. Execution
  `deadlineMs = Date.parse(approval.consumedAt) + workflowTimeoutMs`.
  `assertContinuable` from planning onward uses that deadline.
- A waitpoint `timed_out` still expires the approval and ends the run as
  `expired`, same as today.

If the approval is consumed but `consumedAt` is missing, fail closed
(`approval_consumed_at_missing`) rather than falling back to
`run.createdAt`.

### Reconciliation

Today (`workflow-reconciliation.ts`): any active feature or goal run
(`pending` | `running` | `waiting`) dies when
`now >= createdAt + workflowTimeoutMs` (goals may use a shorter config
timeout, still capped at 60 minutes). That CAS also expires pending
approvals.

Change the feature/goal rules:

1. `waiting` + pending approval with `expiresAt <= now` → expire the
   approval and fail the run (`approval_expired`). Do not use the
   execution deadline.
2. `waiting` + pending approval still live → skip the execution deadline.
   The waitpoint and approval TTL are the authority.
3. Feature `running` or `pending` → execution deadline is
   `consumedAt + workflowTimeoutMs` when a consumed spec/DoD approval
   exists, otherwise `createdAt + workflowTimeoutMs` (worker never picked
   up the spec session).
4. Goal parent with any non-terminal child → skip the goal execution
   deadline. A child waiting overnight must not kill the parent.
   Goal parents do not grow a new column: if the parent is still
   `running`/`waiting` after every child is terminal, fail it at
   `lastTerminalChild.completedAt + min(goals.timeoutMs, MAX_WORKFLOW_TIMEOUT_MS)`
   (coordinator stuck after the children finished). If it has never
   dispatched a child, keep `createdAt + that same cap`.

`MAX_WORKFLOW_TIMEOUT_MS` stays 60 minutes. It is the execution ceiling,
not a permission to let a running session live 24 hours.

### What this does not change

Budgets, session timeout (20 minutes), one-retry, scope hash, waitpoint
as wake-only, and the requirement that a late approve against an expired
approval is a no-op. A run whose spec session never starts still dies at
`createdAt + 60m` while `pending`.

## File map

Slice 1:

- Create: `packages/core/src/acceptance-tests.ts` and
  `packages/core/src/acceptance-tests.test.ts`
- Modify: `packages/core/src/index.ts` (export)
- Modify: `packages/adapters/src/trigger/schemas.ts`
  (`definitionOfDoneSchema` v2) and `schemas.test.ts`
- Modify: `packages/adapters/src/trigger/workflow.ts` (seal, consume
  sealed-changes, `acceptance_path_reserved`)
- Modify: `packages/adapters/src/trigger/workflow.test.ts`
- Modify: `packages/adapters/src/trigger/production-handler.ts`
  (`exactTrustedCommand` suffix; `sealed-changes` remap)
- Modify: `packages/adapters/src/trigger/production-handler.test.ts` /
  verifier tests that construct DoD fixtures
- Modify: `packages/adapters/src/trigger/goal-verifier.seam.test.ts` and
  any other `definition-of-done-v1` fixtures
- Modify: `agentos/passerine.yaml`,
  `apps/control-plane/src/ui/setup-template.ts`,
  `setup-template-local.ts`
- Modify: `apps/control-plane/src/application/control-plane-service.ts`
  (`ApprovalSummary`, `approvalSummary`)
- Modify: `apps/control-plane/src/application/control-plane-service.test.ts`
- Modify: `apps/control-plane/src/ui/inbox-view.tsx`, `inbox-view.test.ts`
- Modify: `docs/architecture/durable-feature-workflow.md` (steps 2 and 5)

Slice 2:

- Modify: `packages/adapters/src/trigger/types.ts`
- Modify: `packages/adapters/src/trigger/workflow.ts`
  (`deadlineMs`, `expiresAt`, `triggerWaitDuration`)
- Modify: `packages/adapters/src/trigger/workflow.test.ts` (waitpoint
  timeout bound; execution deadline after consume)
- Modify: `apps/control-plane/src/application/workflow-reconciliation.ts`
  and `workflow-reconciliation.test.ts`
- Modify: `docs/architecture/durable-feature-workflow.md` Limits section
  (the bullet "absolute 60-minute domain deadline, including approval
  waits")

## Do not modify

- `packages/core/src/dod.ts`, `dod.test.ts`
- `packages/core/src/verification-policy.ts`
- Publication HMAC / GitHub App / local-git plumbing
- `FEATURE_WORKFLOW_TASK_ID` / `GOAL_WORKFLOW_TASK_ID`
- Budget admission SQL, session lease keys, Trigger queue names
- `agentos/agent-os.yaml` (untracked local overlay)

## Sequencing and verification

Slice 1 first. A false green is worse than a 58-minute window. Slice 2
next, in the same implementation plan as a second batch of tasks, so the
deadline tests are written against the new DoD fixtures rather than v1.

Contract tests stay credential-free. The load-bearing new tests:

- v1 DoD fails to parse; v2 with a missing file for a criterion fails;
  path outside `test/acceptance/` fails.
- `sealChangeSet` rejects an implementer change under the prefix, overlays
  otherwise, and the sealed digest is what the observation binds.
- `exactTrustedCommand` contains `node --test test/acceptance/` after the
  project invocation.
- Inbox summary includes acceptance file bodies.
- A feature run still `waiting` at `createdAt + 90m` with a live approval
  is not failed by reconciliation.
- The same run with `expiresAt` in the past is failed as
  `approval_expired`.
- After consume, `createdAt + 90m` does not kill a running feature whose
  `consumedAt + 60m` is still in the future; `consumedAt + 60m` does.

No live Trigger, model, R2, or GitHub calls. Reproducing the todo-store
defect is a manual check after implementation: a fixture change set with
the shallow `createTodoStore` plus frozen mutation tests must fail sealed
verification.

## Out of scope

A second LLM writing tests without seeing the implementation; operator-
supplied acceptance files at feature-start; auto-approve for local
experiments; raising the $2 workflow cap to fund a red-phase session;
Python/Go acceptance runners; making `waiting` count as spend.
