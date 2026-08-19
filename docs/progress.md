# Build progress

Last reviewed: 2026-08-18

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

Automatic merge, deployment, teams, tenancy, billing, and unrestricted business
automation remain out of scope.
