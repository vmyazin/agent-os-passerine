# Multi-Project Parallel Operation

Status: Phase 1 implemented (see docs/superpowers/plans/2026-08-20-multi-project-configuration.md); later phases pending
Date: 2026-08-20
Approach: remove four deliberate POC singletons; the domain model underneath
is already project-scoped

## Goal

Let the single trusted operator run several projects — GitHub-bound or local
experiments — side by side: distinct configurations, runs executing in
parallel, independent budgets, and a control plane that lets them switch
context without losing the thread. Teams, tenancy, and multi-operator
concerns stay out of scope (PRODUCT.md).

This design was preceded by a code audit (2026-08-20). Its finding: the
schema and most subsystems are already multi-project — `workflow_runs`,
`config_revisions`, `workflow_budget_reservations`, and goal records all
carry `project_id`; revision numbering is per-project
(`unique(project_id, revision)`); the budget-admission SQL sums spend per
project; artifact keys embed the project (`artifacts/v1/<projectId>/…`) and
are cross-checked against the run's project; run creation validates
provenance against the *requested* project's revisions; the inbox already
attaches per-project names. What remains single-project is a set of
deliberate narrowings, concentrated in four places.

## The four load-bearing singletons

1. **Configuration.** `DomainRepository.getLatestConfigRevision()`
   (`packages/core/src/persistence.ts:470`) has no project parameter.
   `applyConfiguration` reuses that global row's `projectId` or a constant
   deterministic id (`apps/control-plane/src/application/control-plane-service.ts:751-753`),
   so a second project can never be created. Worse, the optimistic-
   concurrency precondition in both adapters compares against the *globally*
   newest revision (`neon-repository.ts:427-433` `active_revision` CTE has
   no `project_id` filter; `in-memory.ts:344-361` mirrors it), while
   `next_revision` is per-project. With two projects, every apply to A after
   an apply to B fails `configuration_stale`, and first-apply for project #2
   (`expectedRevision: null` → "table must be empty") is unreachable.
2. **Agent-session lease.** `workflow_session_leases` only ever holds one
   row, `lease_key = 'global-agent-session'`, guarded by one global advisory
   lock (`drizzle/0014_orphan_session_fence.sql:23-37,57-68`;
   `postgres-checkpoint-store.ts:294`). Exactly one paid agent session may
   exist deployment-wide, regardless of project.
3. **Trigger queues.** Both durable tasks declare
   `queue: { concurrencyLimit: 1 }` (`trigger/task.ts:38`,
   `trigger/goal-task.ts:44`) — one global slot each.
4. **GitHub binding.** `GITHUB_SELECTED_REPOSITORIES_JSON` and the reader
   equivalent are asserted to exactly one repository in three places
   (`production-composition.ts:224-229`, control-plane `runtime.ts:110-129`),
   and the env-bound repo — not the config's — is what runs use. The
   underlying publisher already matches manifests against a *list*
   (`github/publisher.ts:349-352`); only the composition layer narrows it.
   Local mode (`project.localPath` under `AGENTOS_LOCAL_WORKSPACES_ROOT`)
   is already per-project and needs nothing.

Secondary findings, addressed in later phases: budget *limits* are the
hardcoded `FEATURE_WORKFLOW_DEFAULTS` ($2 workflow / $5 daily) and never
read `config.budgets`; Managed Agents remote resources are named by bare
config-local ids (`agentos:implementer`), so two projects using template
agent names collide; the reconciliation cursor is one global serial row;
the worker's `sourceBundles` map never evicts; the trusted-test-command
allowlist and verification registry hosts are deployment-global; the
control-plane configuration page renders a static YAML file
(`AGENTOS_CONFIG_PATH`) rather than the applied revision; the Projects page
and rail badge render a hardcoded fixture (`PLACEHOLDER_PROJECTS`).

## Concepts

**A project is a binding plus its configuration history.** Its identity is
derived from the binding, not chosen by the caller: a deterministic project
id from the literal `project.repository` URL or `project.localPath` value —
never realpath, so identity is environment-independent — falling back to
`project.name` for configs with no binding yet (a dev-only state; dispatch
already requires a binding), via the existing deterministic
`generateId('project', <binding>)` machinery. Applying a configuration whose binding has no project yet
*creates* the project; applying to a known binding appends a revision to
that project's chain. No new "create project" endpoint is needed, and the
CLI/wizard never have to know a project id before their first apply.

**Back-compat rule:** if the store's newest revision belongs to a project
whose binding matches the incoming config, reuse that project even when its
id predates binding-derived ids (existing deployments keep their project and
its history). Otherwise the binding-derived id decides. Renaming
`project.name` never changes identity; changing the binding is a new
project.

**Parallelism unit: one agent session per project.** The session lease
becomes `agent-session:<projectId>`; different projects proceed
concurrently, and within a project the current one-session safety posture
(never two paid sessions for overlapping work) is preserved. Honoring
`config.budgets.concurrency > 1` *within* a project is explicitly deferred —
the lease-key scheme (`agent-session:<projectId>:<slot>`) admits it later
without another migration of meaning.

## Phase 1 — Project-scoped configuration

The unblocking phase; everything else builds on it.

- Port: `getLatestConfigRevision(projectId: ProjectId)` in
  `packages/core/src/persistence.ts` and both adapters. No global variant
  survives; callers that "just want the active config" now name a project.
- Neon: add `where "project_id" = …` to the `active_revision` CTE; drop the
  deployment-wide `pg_advisory_xact_lock('agentos:configuration')`
  (`neon-repository.ts:411-413`) — the per-project lock at `:418-420`
  already serializes correctly. Mirror in `in-memory.ts`.
- Service: `applyConfiguration` resolves the project by binding as described
  in Concepts; remove the `active?.projectId ?? constant` collapse.
- HTTP: `GET /api/configuration?projectId=…` (relaxing `assertNoQuery` with
  an allowlisted-query variant), optional `projectId` in
  `configurationApplySchema`/`setupApplySchema` as an integrity check (409
  if it disagrees with the binding-derived project), `projectId` on
  `GET /api/setup/repository-head`. Optional `?projectId=` filters on
  `GET /api/runs` and `GET /api/inbox` — `RunListFilter.projectId` already
  exists in both adapters and is simply never passed.
- CLI: `config plan`/`config apply` read `project` from the loaded config
  and pass the resolved projectId; `feature start`/`goal start` default
  `--project-id` from the applied config's response. Print projectId +
  provenance digests from `config apply` in copy-pasteable form.
- Fix the adjacent 500: feature-run creation without workflow dispatch
  accepts any `projectId` and dies on the `workflow_runs.project_id` FK —
  return a clean 404/422 for an unknown project.
- Tests: two-project isolation cases in
  `repository-parity-contract.ts` — independent revision chains, CAS
  preconditions that ignore the other project, project #2 creatable while
  project #1 exists. These encode the exact latent bug class.

## Phase 2 — Parallel execution

- Migration: session lease key becomes `agent-session:<projectId>`; the
  admission function's advisory lock keys on the project
  (`hashtextextended(p_project_id, 0)`), and `releaseSession` matches. Keep
  the 0014 posture that only reconciliation releases a lease, but a
  stranded lease now freezes only its own project; verify orphan
  reconciliation covers every project (see cursor below).
- Trigger: per-project queues (`agentos-feature-<projectId>`,
  `agentos-goal-<projectId>`) with `concurrencyLimit: 1` each, chosen at
  trigger time — cross-project parallel, per-project serial, and no
  goal↔child-feature deadlock since goal and feature remain distinct
  queues.
- Reconciliation: cursor key becomes `feature-workflow-outbox-v1:<projectId>`
  (the `workflow_reconciliation_cursors` table already supports multiple
  rows); the sweep iterates projects and passes the existing
  `listRuns({ projectId })` filter, so one project's stuck run cannot delay
  another's dispatch.
- Managed Agents: namespace remote resource names and `LOCAL_ID` metadata
  as `agentos:<projectId>:<agentId>` (same for environments), and key the
  provider's `#agents`/`#environments` caches on the composite. Existing
  singleton-named remotes are recreated under new names; stale ones are
  inert and cleaned up manually once.
- Worker hygiene: bound the `sourceBundles` cache
  (`production-handler.ts:449`) — evict on run completion or LRU-cap it.

## Phase 3 — Multi-repo GitHub binding

- Allow N entries in `GITHUB_SELECTED_REPOSITORIES_JSON` /
  `GITHUB_READER_SELECTED_REPOSITORIES_JSON`; delete the three
  `length !== 1` assertions. The env vars stay the operator-reviewed
  allowlist of immutable `(owner, name, installationId, repositoryId)`
  tuples, per the trusted-publisher design; a per-project DB binding table
  is deliberately not introduced.
- Selection: resolve `config.project.repository` against the allowlist
  (moving the existing `production-handler.ts:506-527` cross-check into
  selection); a config naming an unlisted repo fails closed at dispatch and
  at apply-time readiness. Reader and publisher entries must still match
  pairwise per repository.
- Key the memoized reader/ingestor/publisher constructions per repository
  instead of per process (control-plane `runtime.ts:155-181,446-464`).
- Split `setupReadiness` into deployment readiness (DB, Trigger, R2, keys,
  workspaces root) and per-project readiness (is this config's binding in
  the allowlist; head resolvable), consumed by the wizard per project.

## Phase 4 — Control-plane UI

- Projects page: replace `PLACEHOLDER_PROJECTS` with a
  `ControlPlaneService.listProjects()` projection (name, binding, latest
  revision + digest, last run, run count, updated), empty state pointing at
  Setup; rail badge counts real projects via `fetchRailCounts`.
- Project detail page `/projects/[id]`: provenance header, per-project runs,
  spend vs budget, links to configuration — the home for the approved
  dashboard mockup (2026-08-18).
- Setup wizard: project-addressable — a project list/switcher above step 2
  instead of the single component-local `applied` slot; local-repository
  creation already scales (`todo-app-01`, `-02`, …). Replace the fragile
  first-`name:` regex substitution with parameterized template rendering.
- Configuration page: read the selected project's applied revision from the
  database; retire `AGENTOS_CONFIG_PATH` as a UI source.
- Runs and inbox pages: project filter chips backed by the Phase 1 query
  params; run rows and inbox items already display project names.

## Phase 5 — Budget and policy correctness

- Thread `config.budgets.{workflowMicrodollars,dailyMicrodollars,admissionReservePercent}`
  from the run's snapshot into session admission/settlement in place of
  `FEATURE_WORKFLOW_DEFAULTS` (`workflow.ts:652-656`,
  `outbox.ts:550-551,778-779`); fix the `spent` double-use where a per-run
  sum is passed as the daily figure.
- Add an optional deployment-wide daily cap
  (`AGENTOS_DEPLOYMENT_DAILY_MICRODOLLARS`) checked in the admission
  function above the per-project caps — N parallel projects currently
  multiply spend on one shared provider key with no ceiling.
- Move `AGENTOS_TRUSTED_TEST_COMMANDS_JSON` and
  `AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON` semantics to per-project
  config (env value may remain the deployment allowlist that per-project
  config must be a subset of), so one project's allowed commands are not
  automatically allowed for every project.

## Sequencing and verification

Phases 1–2 are the critical path and are surgical: a port signature, two
CTE filters, one migration, queue naming, resource naming. Local mode makes
multi-project demoable immediately after them — two experiment projects
running in parallel with no GitHub changes — which is why Phase 4 comes
before Phase 3 if a choice is forced. Each phase gets its own
implementation plan in `docs/superpowers/plans/` before execution.

All phases stay inside the existing verification boundary: unit and parity
tests run credential-free (two-project cases included), PostgreSQL
integration under `TEST_DATABASE_URL` exercises the new migration and CAS
scoping, Playwright covers the projects page/switcher, and no live Trigger,
model, R2, or GitHub calls are required by default.

## Out of scope

Teams, tenancy, per-project operators or tokens; automatic merge or deploy;
`config.budgets.concurrency > 1` within one project; per-project R2 buckets
(application-level scoping is already enforced); moving GitHub binding
tuples into the database.
