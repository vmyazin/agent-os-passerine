# Operator UI Parity With The CLI

Status: Draft design
Date: 2026-08-23
Approach: move each write action to the page whose subject it acts on, and
close the three capabilities the browser genuinely cannot reach — leaving
the CLI for automation rather than as the only door

## Context

The CLI is the complete surface. The browser is not — but the gap is
narrower and stranger than it looks, so it is worth stating exactly.

| CLI | In the browser today |
| --- | --- |
| `init` | n/a — writes a local file |
| `config validate` | implicit: `/api/setup/apply` rejects invalid YAML |
| `config plan` | **nothing** |
| `config apply` | setup wizard step 2, paste-only (see below) |
| `feature start` | setup wizard step 4 |
| `feature start --base-run` | **nothing** |
| `goal start` | setup wizard step 4, with a criteria picker |
| `goal show` | run page renders the goal projection |
| `runs list` / `show` / `cancel` | `/runs`, `/runs/[id]`, cancel action |
| `inbox list` / `reply` / `approve` / `reject` | `/inbox` |
| backlog create / pause / resume | **nothing** (API only) |

Three findings decide the shape of the work.

**1. Starting work lives in a page called Setup.** The wizard can load an
existing project's applied provenance and go straight to starting a run
(`setup-wizard.tsx:213-240`), so a second feature *is* startable — behind a
four-step onboarding flow named after configuration. A returning operator
looking at a project has no action that starts anything. This is an
information-architecture problem, not a missing capability, and it is why
the CLI keeps getting reached for.

**2. Configuration cannot round-trip in the browser.**
`GET /api/configuration` returns provenance but withholds `canonicalConfig`
from session callers — deliberately: environment variable maps are free-form
and may hold credentials, which is also why the configuration page masks
them. So the wizard's editor cannot show you your current configuration, and
`config plan` — the diff that tells you what an apply would change — has no
browser equivalent at all. Applying blind is the only option.

**3. Everything else is reachable but scattered.** Cancel lives on the run
page, approve/reply on the inbox: both correct. Nothing else has a home.

## Goal

An operator can run the entire loop — configure, start, watch, decide,
follow up — from the browser, and reaches for the CLI when scripting or
piping JSON, not when the UI simply cannot do a thing.

## Non-goals

- **Do not remove or weaken the CLI.** It stays the automation surface, and
  `--json` output stays its own contract.
- **Do not port `init`.** It scaffolds a local file; the browser has no
  filesystem and the wizard's template generator is the equivalent.
- **Do not return raw `canonicalConfig` to session callers.** The masking is
  a deliberate credential boundary; the plan below works with it rather than
  arguing with it.
- Do not build a YAML editor with schema completion, a config version
  browser, or run-input editing.
- Do not change any API's authorization model, budget admission, approval
  semantics, or the wizard's first-run flow for a genuinely new project.

## Concepts

**Actions live where their subject lives.** A run is started from the
project that will own it, or from the run it follows. A backlog is created,
paused, and resumed on its project's page. Configuration is planned and
applied on the configuration page. Setup keeps exactly one job: taking a
project from nothing to a first applied configuration.

**Provenance is resolved, never typed.** The CLI asks for five digests and a
SHA because a script has them. A person does not. Every start action in the
browser resolves provenance server-side from the project's applied revision,
the way the backlog dispatcher already does
(`control-plane-service.ts` `dispatchBacklogItem`). No form ever asks a
human to paste a hash.

**Start from the applied revision, and say so when it has drifted.** A run's
`repositorySha` must equal the applied revision's, so a start action uses
that SHA — not the branch head, which may have moved. When they differ, the
UI says which commit the run will build on and offers re-applying
configuration to pick up the newer one. Silently using the head produces a
409 the operator cannot interpret; silently using the old SHA builds on code
they think they replaced.

**Every start states its ceiling.** A run may spend up to the project's
workflow cap against its daily cap. The button that spends it says so.

**Plan before apply, without moving secrets.** The browser cannot be shown
the stored YAML, but it can be shown *the difference between what it is
about to send and what is applied*. The operator pastes or edits YAML, the
server parses it, diffs it against the active revision, and returns a
change summary — the same `planConfigChange` the CLI uses. Nothing sensitive
leaves the server, and applying blind stops being the only option.

## Slice 1 — Start work from the project

Project page gains a **Start a run** action opening a form: title,
description, pipeline (feature or goal), and for a goal the existing
criteria picker (`/api/goals/commands?projectId=`).

- Provenance and SHA are resolved server-side from the latest applied
  revision. The form posts title, description, projectId, and criteria only.
- A drift notice when the applied revision's SHA is behind the resolved
  head, naming both and linking to Setup to re-apply.
- The cost ceiling stated next to the submit control.
- Empty state when the project has no applied configuration: link to Setup,
  because that is exactly its job.

This needs one new session-authorized endpoint, `POST /api/projects/:id/runs`,
that fills provenance from the applied revision and delegates to
`createFeatureRun` / `createGoalRun`. The CLI keeps its explicit-provenance
endpoints unchanged: a script that pins digests must keep failing when they
no longer match, which is the whole point of pinning them.

## Slice 2 — Follow-up runs

On a succeeded run that recorded a publication, a **Start a follow-up**
action posts the same shape with `baseRunId` set, so chaining is reachable
without the CLI. On a run that published nothing, the action explains why it
is unavailable rather than disappearing.

## Slice 3 — Backlogs

On the project page:

- **Create a backlog**: title plus repeatable item rows (title,
  description); posts to the existing `POST /api/backlogs`.
- **Pause / resume** on the backlog card, through the existing status route.
- **Progress**: "2 of 4 done · now running <item>", and the waiting state
  named for what it is — an item whose run is `waiting` on an approval reads
  *waiting for your approval* and links to the inbox message, because that
  is the single most common state a backlog will be in and it currently
  reads as "running".
- **Paused reasons in words.** Map each code to a sentence and its next
  action; `chain_depth_reached` names the branch to merge.

## Slice 4 — Plan and apply configuration

Configuration page gains an editor and two actions:

- **Plan**: `POST /api/configuration/plan` (session-authorized) parses the
  submitted YAML, diffs it against the active revision with the core
  `planConfigChange`, and returns the summary. Read-only, spends nothing,
  and never returns stored values.
- **Apply**: the existing `/api/setup/apply` route, unchanged, with the
  plan shown above the button.

The page keeps rendering the applied revision with environment variables
masked. The editor starts empty with a note saying why: the stored
configuration is not echoed back because it may carry credentials.

## Slice 5 — Parity as a maintained claim

A table in `docs/architecture/` mapping every CLI command to its browser
equivalent, with deliberate gaps marked as such (`init`, `--json`). The CLI
help text points at it. A capability added to one surface without the other
should be a visible omission, not a discovery six months later.

## Verification

- Contract tests for the new endpoints, including: a start with no applied
  configuration is a clean 409, a start on a drifted project uses the
  applied SHA, and the plan endpoint never returns stored configuration
  values.
- The run-start form resolves provenance server-side — asserted by the
  request body containing no digests.
- Backlog create/pause/resume through the UI's own routes.
- Browser checks at desktop and 390 px for each new surface, against seeded
  data: a project with and without configuration, a drifted project, a
  backlog mid-flight, a paused backlog, a succeeded run with and without a
  publication.

## Out of scope

`init`, `--json`, a schema-aware YAML editor, configuration history
browsing, editing a run after creation, and anything that changes how the
CLI authenticates.
