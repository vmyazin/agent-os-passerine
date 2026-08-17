# Build progress

Last reviewed: 2026-08-17

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
   reconciliation, trusted command verification, one review/fix/final-review
   pass, trusted publication, cancellation, and cleanup reconciliation.

## Verification boundary

The default suite is designed to run without cloud credentials or paid model
calls. PostgreSQL integration runs when `TEST_DATABASE_URL` is supplied. Live
Managed Agents and R2 smoke tests require the explicit `AGENTOS_LIVE_TESTS=1`
opt-in. No Trigger deployment, model session, R2 write, GitHub branch, or pull
request has been created by the implementation session.

The durable workflow task is fully testable through stable local interfaces.
The repo-owned task registers its fail-closed concrete composition at module
load; runtime initialization resolves Neon, R2/source bundles, Managed Agents,
trusted test execution, and the composite GitHub publisher from server-only
environment variables. No Trigger deployment, R2 source bundle, paid model
session, or GitHub publication was exercised in this build. PostgreSQL
integration also remains unexecuted when `TEST_DATABASE_URL` is absent.

## Remaining product stages

- Bounded autonomous goal loop with deterministic DoD criteria and a three-step
  cap.
- Broader reliability/security operations: webhook signatures and replay
  protection, dead-letter UI, telemetry, rotation, alerts, and adversarial live
  validation.
- Rootless self-hosted VM runtime provider and managed/self-hosted equivalence
  measurements.
- Signed diagnostic/repair triggers, recurring business tasks, PWA push
  notifications, and mobile approval/reply flows.

Automatic merge, deployment, teams, tenancy, billing, and unrestricted business
automation remain out of scope.
