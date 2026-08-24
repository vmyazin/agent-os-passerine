# Build progress

Last reviewed: 2026-08-23

## Completed foundation steps

1. **Workspace and zero-cost simulation:** strict TypeScript pnpm/Turborepo,
   CI, formatting, unit/E2E tooling, architecture decisions, threat model,
   configuration validation, state machines, policies, fake adapters, and
   deterministic simulation.
2. **Durable domain/control plane:** Neon/Drizzle persistence, migrations,
   GitHub OAuth operator boundary, run/inbox/approval APIs and screens,
   sanitized projections, CLI parity, idempotency, and atomic domain events.
3. **Managed execution and artifacts:** isolated Managed Agents adapter,
   capability-scoped content-addressed R2 artifact store/MCP, retention cleanup,
   and provider contract tests.
4. **Trusted GitHub publication:** selected-repository GitHub App tokens,
   bounded full-file changes, protected paths, stale-base protection,
   idempotent Git Data publication, and draft-only PR creation.
5. **Durable feature coordination:** Trigger.dev v4 task/wait integration,
   fenced Postgres side-effect delivery, reserved/settled spend, sealed runtime
   handles, scoped spec/DoD approval, separate role sessions, provider start
   reconciliation, read-only GitHub SHA-bound source ingestion, mounted
   upstream artifacts plus logical-step-scoped Managed vault/MCP access,
   isolated provider-observed command verification, one review/fix/final-review
   pass, trusted publication, independent cancellation, sealed ambiguous-start
   recovery, config-bound actual orphan pricing, cleanup reconciliation, and a
   persistent fair reconciliation cursor. Current hardening also includes
   complete prompt-cache pricing, delayed independent absence confirmation,
   a separate read-only source GitHub App identity, safe apply-to-start
   provenance projection, a one-MiB source-bundle transport limit, and a
   secretless frozen-lockfile verifier with a trusted registry allowlist.
6. **Bounded goal loop:** pure three-step goal reducer with canonical event
   fingerprints and stuck/step-limit detection, immutable criterion provenance
   bound to one applied configuration revision, idempotent goal
   criterion/progress records with a legacy fail-closed migration, HMAC
   kind-separated trusted command verification issuing DoD attestations,
   replay-safe durable goal coordination over deterministic feature children,
   goal-owned child dispatch/cancellation protection, pipeline-bound outbox
   dispatch of `agentos-goal-workflow-v1`, strict fail-closed goal input
   validation shared by task entry, reconciliation, and durable execution, and
   a sanitized bounded goal projection with run-page and CLI
   (`--criteria-json`, `goal show`) parity.
7. **Self-hosted runtime, started via the Kimi provider:** a `kimi`
   `RuntimeProvider` (`packages/adapters/src/kimi/`) that owns its own agent
   loop against Moonshot's Anthropic-compatible Messages API and executes
   tools in a local, path-confined process sandbox; secretless
   provider-executed `observeCommand` mutually excluded from the agent loop
   by a per-session mutex, preserving the existing signed trusted-test-report
   and DoD attestation chain unchanged; `config.runtime.{provider, routing}`
   is now authoritative and fail-closed (an unbuilt/unconfigured resolved
   runtime, including the legacy starter `provider: local`, rejects at
   composition instead of silently defaulting); and step-scoped Artifact MCP
   access staged locally in-process and discarded worker-side. See
   [kimi-runtime.md](./architecture/kimi-runtime.md) for the full design,
   including the limitations recorded below and its process/path isolation
   boundary, unenforced `networking: limited`, and worker-local sessions
   that fail closed on restart by design.

## Verification boundary

The default suite is designed to run without cloud credentials or paid model
calls. PostgreSQL integration runs when `TEST_DATABASE_URL` is supplied. Live
Managed Agents and R2 smoke tests require the explicit `AGENTOS_LIVE_TESTS=1`
opt-in. No Trigger deployment, model session, R2 write, GitHub branch, or pull
request has been created by the implementation session.

The Kimi runtime provider follows the same boundary: its unit, routing, and
composition tests all run against a fake transport and are credential-free
and cost-free by default. The one live gate,
`pnpm --filter @agentos/adapters smoke:kimi`, sends one real Moonshot request
and stays skipped (exit 0) unless both `AGENTOS_LIVE_TESTS=1` and
`KIMI_API_KEY` are set, so no build or CI run spends against a real Kimi
session unless an operator opts in explicitly.

The durable workflow task is testable through stable local interfaces. The
repo-owned task registers its fail-closed concrete composition at module load;
runtime initialization resolves Neon, R2/source bundles, Managed Agents,
secretless sandbox test observation, and the composite GitHub publisher from
server-only environment variables. This implements the staged
feature-workflow slice but does not establish its live exit gate. No Trigger
deployment, R2 source bundle, paid model session, or GitHub publication was
exercised in this build. PostgreSQL integration also remains unexecuted when
`TEST_DATABASE_URL` is absent.

The fresh Playwright control-plane suite passes all three browser cases,
including approval consumption and the 390 px inbox viewport check.

The operator inbox now uses an email-style request queue and reading pane instead
of isolated cards. Approvals and questions share one newest-first list, machine
details use progressive disclosure, and completed questions retain both the
original agent message and the operator's sent reply as visible conversation
history after reload. The layout stacks without horizontal overflow at a 390 px
viewport. The approval and reply mutations remain unchanged.

The bounded goal loop is implemented and tested through the same no-cost
boundary: goal criteria evaluate only signed provider-observed command
evidence, and no goal Trigger deployment or live goal attempt has been
exercised in this build.

The PostgreSQL integration suite now passes against a live Neon database,
including the goal record migration and parity contract. First execution
against real Postgres surfaced and fixed four latent defects: two untyped
SQL parameter comparisons (configuration-apply CAS and capability quota
arithmetic), microsecond-precision repository timestamps rejected by the
millisecond-canonical artifact metadata contract, and a miscounted
publication revision expectation. The suite also now passes search_path
through the startup options parameter so Neon's proxy honors it.

## Remaining product stages

- Broader reliability/security operations: webhook signatures and replay
  protection, dead-letter UI, telemetry, rotation, alerts, and adversarial live
  validation.
- Rootless container/VM isolation for the self-hosted runtime (the Kimi
  provider's sandbox remains process/path-confined only, with
  `networking: limited` unenforced — see
  [kimi-runtime.md](./architecture/kimi-runtime.md)) and managed/self-hosted
  equivalence measurements.
- Signed diagnostic/repair triggers, recurring business tasks, PWA push
  notifications, and mobile approval/reply flows.

Local experiment projects are implemented: the feature pipeline can run
against a local git repository (`project.localPath` +
`AGENTOS_LOCAL_WORKSPACES_ROOT`) with local source ingestion and
local-branch publication behind the existing seams, a guided setup-wizard
mode, and no GitHub Apps required.

Multi-project operation is implemented — all five phases of
[the multi-project design](./superpowers/specs/2026-08-20-multi-project-parallel-design.md):
project-scoped configuration and CAS preconditions, per-project session
leases, multi-repo GitHub binding with split deployment/project readiness, a
live projects UI with per-project filters, and budgets read from each
project's configuration.

Per-project *execution* concurrency is keyed, not queued, and that caveat
came due. Phase 2 dispatched each run to a queue named for its project;
Trigger parks a run on a queue that no task declares in `PENDING_VERSION`
until its TTL expires, so from 2026-08-20 every run was enqueued, reported
as dispatched, and never executed. The unit tests asserted what the
dispatcher passed to a fake SDK and could not see it. Dispatch now sets
`concurrencyKey` on the task's declared queue, which copies that queue per
project -- the behaviour Phase 2 wanted. `pnpm --filter @agentos/adapters
smoke:trigger-dispatch` proves a dispatched run reaches a worker, against
real Trigger, and is the check that would have caught it.

The Definition of Done is now executable and frozen. A feature run's
specifier writes one `test/acceptance/<criterionId>.test.mjs` file per
criterion into the hashed DoD artifact; the operator reads those files in
the approval inbox before implementation starts; trusted code overlays them
onto the implementer's change set (an implementer write under that prefix is
a permanent error) and runs them in the sealed sandbox after the project's
own suite. The implementer's tests still run — as evidence of what the
author believed, not as the gate. This closes the failure the todo-app-02
run demonstrated: five green steps and a published branch whose store handed
out its internals, because the author wrote both the code and the tests that
judged it. Approvals also have their own 24-hour TTL, and the 60-minute
execution budget starts when the approval is consumed, so acceptance tests
can be read overnight without spending the run's clock.

Run chaining is implemented
([design](./superpowers/specs/2026-08-23-run-chaining-design.md),
[plan](./superpowers/plans/2026-08-23-run-chaining.md)): a feature run may
name `baseRunId`, and the control plane resolves that run's published branch
and commit from its own outcome record — the caller never supplies a source
SHA. Ingestion reads the base commit, publication bases on the base branch,
and the branch stack accumulates until the operator merges the last one.
`provenance.repositorySha` still pins the applied configuration revision and
every existing assertion runs against it unchanged. Five refusals cover a
base that is missing, unfinished, another project's, unpublished, running
under a different configuration revision, already chained, or too deep
(`config.chains.maxDepth`, default three).

Verification boundary for chaining: the branch-stacking claim is proved
against a real git repository through the local-git publisher (run A off
`main`, run B off A's branch, B's tree carrying both files, `main`
untouched), and every refusal has its own credential-free case. What has
*not* run is a chained pair driven by real agent sessions end to end — that
needs paid model calls and a Trigger deployment, so it stays an explicit
gap rather than an implied pass.

Project backlogs are implemented
([design](./superpowers/specs/2026-08-23-project-backlog-design.md),
[plan](./superpowers/plans/2026-08-23-project-backlog.md)): an ordered list
of feature requests per project, advanced by the reconciliation loop one
chained item at a time, pausing on anything that is not a plain success.
Together with chaining this is the difference between executing a feature
and executing a project: the operator writes the list once and answers each
run's spec/DoD approval, instead of hand-issuing every run and merging
between them. The scheduler itself is a pure decision function, so its whole
contract is a case table that runs without a database.

Verification boundary for backlogs: the decision table, the dispatch
idempotence, the pause-on-failure rule, and completion all run
credential-free; both repository adapters agree through the parity contract,
validated against real PostgreSQL on a disposable Neon branch (integration
suite 33/33) — which is where the parity cases surfaced that this adapter's
unique-violation check ignored drizzle's error wrapping, so every conflict in
it, including two pre-existing goal-criterion paths, reported an opaque
failure instead. No backlog has been driven end to end by real agent
sessions; that needs paid model calls and a Trigger deployment.

The browser now reaches what the CLI reaches
([design](./superpowers/specs/2026-08-23-operator-ui-parity-design.md),
[plan](./superpowers/plans/2026-08-23-operator-ui-parity.md),
[table](./architecture/cli-ui-parity.md)). Starting work moved out of the
setup wizard and onto the project that will own it, with provenance resolved
from the applied revision instead of typed; a succeeded run offers to start
the next one chained onto its published commit; backlogs are created,
paused, and resumed on the project page; and a configuration change can be
planned before it is applied. `init` and `--json` stay CLI-only on purpose.

The credential boundary held under review and then did not: the plan
endpoint masks `environments[].variables` on both sides of a diff, which the
first implementation did only for leaf paths — an added or removed
environment carries the whole object, variables inside. Found by reading a
real plan against a real project, fixed, and covered by a test that fails
without it.

Automatic merge, deployment, teams, tenancy, billing, and unrestricted business
automation remain out of scope.
