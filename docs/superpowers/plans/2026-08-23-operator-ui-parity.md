# Operator UI Parity Implementation Plan

**Goal:** the whole operator loop — configure, start, watch, decide, follow
up — runs from the browser, with the CLI kept for automation.

**Spec:** `docs/superpowers/specs/2026-08-23-operator-ui-parity-design.md`

**Architecture:** one new session-authorized start endpoint that resolves
provenance server-side, one read-only plan endpoint, and forms placed on the
page whose subject they act on. No change to CLI endpoints, authorization
models, or budget admission.

## Global constraints

- Do not modify `POST /api/features`, `POST /api/goals`, or
  `POST /api/configuration`. A script that pins digests must keep failing
  when they stop matching.
- Never return `canonicalConfig` to a session caller.
- Every response schema is written with its route; a projection field with
  no schema is a 500 the service tests cannot see.
- Reuse the existing client-mutation pattern in `mutation-forms.tsx` and the
  existing token vocabulary in `globals.css`. No new component library.
- Each new surface is checked in a browser at desktop and 390 px before its
  task is done.

## File map

| Path | Role |
| --- | --- |
| Create `apps/control-plane/app/api/projects/[id]/runs/route.ts` | Session start, provenance resolved server-side |
| Create `apps/control-plane/app/api/configuration/plan/route.ts` | Read-only plan against the active revision |
| `apps/control-plane/src/application/control-plane-service.ts` | `startRunForProject`, `planConfigurationChange`, drift in the project projection |
| `apps/control-plane/src/http/contracts.ts` | Request/response schemas for both routes |
| Create `apps/control-plane/src/ui/start-run-form.tsx` | Start a feature or goal; criteria picker for goals |
| Create `apps/control-plane/src/ui/backlog-forms.tsx` | Create, pause, resume |
| `apps/control-plane/app/projects/[id]/page.tsx` | Mount both; progress and waiting state |
| `apps/control-plane/app/runs/[id]/page.tsx` | Start a follow-up |
| `apps/control-plane/app/configuration/page.tsx` | Editor, Plan, Apply |
| `apps/control-plane/src/ui/backlog-view-model.ts` | Item state → words, paused reason → sentence + action |
| `apps/control-plane/app/api/test/seed/route.ts` | Fixtures for each new state |
| Create `docs/architecture/cli-ui-parity.md` | The maintained mapping |
| `apps/cli/src/main.ts` | Help text points at it |

## Do not modify

`packages/core/src/dod.ts`, `acceptance-tests.ts`, `verification-policy.ts`,
publication HMAC, session leases, Trigger task IDs, budget admission SQL,
`requireApiAuthentication` / `requireCliAuthentication`, and the wizard's
first-run flow for a project with no applied configuration.

## Tasks

### Task 1: Start a run for a project (service + endpoint)

- [ ] `startRunForProject(idempotencyKey, { projectId, title, description,
      pipeline, criteria?, baseRunId? })`: resolve the latest applied
      revision, fill provenance from it, delegate to the existing
      `createFeatureRun` / `createGoalRun`. No applied revision → 409
      `project_unconfigured` with a message naming Setup.
- [ ] `POST /api/projects/[id]/runs`, session-authorized, with request and
      response schemas.
- [ ] Tests: provenance comes from the revision and not the request; an
      unconfigured project is a clean 409; a goal start still enforces the
      trusted-command allowlist; `baseRunId` still goes through every chain
      refusal.
- [ ] Verify: `pnpm --filter @agentos/control-plane test`

### Task 2: Configuration drift, surfaced

- [ ] Project detail projection gains `appliedSha` and `headSha` when they
      can be resolved, plus a `drifted` flag. Head resolution must fail soft:
      a project whose reader is unavailable still renders.
- [ ] Tests: drifted, aligned, and unresolvable heads.

### Task 3: The start form

- [ ] `start-run-form.tsx`: title, description, pipeline toggle, goal
      criteria picker reusing `/api/goals/commands?projectId=`.
- [ ] States the cost ceiling; shows the drift notice from Task 2; empty
      state links to Setup when unconfigured.
- [ ] Mounted on the project page.
- [ ] Verify: browser, desktop and 390 px, configured / unconfigured /
      drifted.

### Task 4: Follow-up runs

- [ ] On a succeeded run with a recorded publication, a start-a-follow-up
      action posting `baseRunId`.
- [ ] A succeeded run without one explains why it cannot chain instead of
      hiding the action.
- [ ] Verify: browser, both states.

### Task 5: Backlog forms and states

- [ ] Create form (title + repeatable item rows) posting to
      `POST /api/backlogs`; pause/resume through the status route.
- [ ] `backlog-view-model.ts`: item status → words, including *waiting for
      your approval* derived from the item's run being `waiting` with a
      pending approval, linking to the inbox message; paused reason → a
      sentence and its next action, with `chain_depth_reached` naming the
      branch to merge.
- [ ] Progress line: "2 of 4 done · now running <item>".
- [ ] Tests for the view model (pure), then browser checks for the forms.

### Task 6: Plan and apply configuration

- [ ] `planConfigurationChange(yaml, projectId)`: parse, canonicalize, diff
      against the active revision with core `planConfigChange`, return the
      summary only.
- [ ] `POST /api/configuration/plan`, session-authorized, read-only.
- [ ] Configuration page: editor, Plan, then Apply through the existing
      `/api/setup/apply`, with the plan rendered above the button and a note
      explaining why the editor does not start populated.
- [ ] Tests: the response never carries stored configuration values; invalid
      YAML is a 422 with a readable message; a stale expected revision is a
      409.
- [ ] Verify: browser, desktop and 390 px.

### Task 7: Parity table and docs

- [ ] `docs/architecture/cli-ui-parity.md`: every command, its browser
      equivalent, and the deliberate gaps marked as deliberate.
- [ ] CLI help text points at it; `docs/progress.md` records what the
      browser can now do and what still needs the CLI.
