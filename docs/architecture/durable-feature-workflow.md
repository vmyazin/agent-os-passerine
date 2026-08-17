# Durable feature workflow

The feature workflow turns one durable feature run into a tested draft pull
request. Trigger.dev coordinates execution, but Postgres remains authoritative
for runs, approval decisions, step outputs, usage, side-effect claims, and
session leases.

## Execution path

1. `POST /api/features` creates the idempotent `pending` domain run. Only after
   that commit does the control plane request the versioned Trigger task.
2. The specification role writes separately hashed specification and measurable
   Definition-of-Done artifacts.
3. The workflow creates a scope hash over the run, configuration, specification,
   and DoD. It stores a domain approval and a Trigger waitpoint reference. The
   waitpoint is only a wake signal; after waking, the task re-reads the consumed
   approval and its atomic `approval.approved` or `approval.rejected` event.
4. Planning, implementation/testing, and review use distinct agents,
   environments, and runtime sessions. A requested fix gets one fresh
   implementation session.
5. Trusted code verifies bounded artifact schemas, tests, DoD evidence, and
   protected-path policy. A trusted publication authority—not an agent—creates
   the publisher input. The GitHub App publisher revalidates the stale base and
   creates only a draft PR.

No runtime request contains GitHub App, branch-push, merge, or publication
credentials. Agent outputs are bounded JSON results containing artifact
manifests; raw reasoning and secrets are not persisted as domain events.

## Replay and failure model

`workflow_effects` records a fingerprint before every Trigger, runtime,
waitpoint, or publisher side effect. Replaying the same key with different input
is a conflict. Completed effects return their prior result. Trigger task starts,
waitpoint completion, and draft publication are safe to retry through their own
idempotency contracts.

A runtime start that is durably marked `started` but has no external reference
is ambiguous. The runner dead-letters it instead of risking a duplicate paid
session. An interrupted publisher call is treated the same way rather than
risking a duplicate PR. An operator or a future provider-specific reconciler
must resolve those records. Cleanup attempts run in `finally`, while the
reconciliation/retention paths remain responsible for cleanup after process
termination.

Trigger retries the version-locked task at most once. Invalid inputs,
unregistered composition, and unclassified handler failures use Trigger's
`AbortTaskRunError`; only the stable `FeatureWorkflowTaskTransientError`
explicitly opts a bootstrap failure into that retry. Agent session retries are
likewise restricted to the runner's classified transient errors.

The control plane uses pending runs, atomic approval events, and atomic
`run.cancelled` events as durable outbox intents. The authenticated internal
route `/api/internal/workflows/reconcile` redelivers them. Trigger and waitpoint
idempotency make duplicate deliveries harmless.

## Limits

The proof-of-concept defaults are fixed in trusted code:

- one global live agent-session lease;
- two attempts per step (one classified transient retry);
- 20 minutes per runtime session;
- an absolute 60-minute domain deadline, including approval waits;
- $2 per workflow and $5 per rolling 24-hour project window, represented as
  integer microdollars;
- no new session at 80% of either cap.

The PostgreSQL admission function takes an advisory transaction lock, recomputes
usage from `usage_records`, applies both thresholds, and acquires the global
lease atomically. After every idempotent usage append, the runner re-enters the
same serialized boundary at 100% to settle reported usage against both hard
caps before continuing. Trigger queue concurrency is defense in depth; it is
not the budget or concurrency authority.

## Local verification

Install dependencies, apply migrations, and run the no-cost contract suite:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm build
```

Set `TEST_DATABASE_URL` to include the PostgreSQL checkpoint/admission contract
in `pnpm test:integration`. Normal CI uses fake Trigger, runtime, artifact, and
publisher boundaries and makes no paid model or cloud calls.

For Trigger.dev local development, set `TRIGGER_PROJECT_REF`,
`TRIGGER_SECRET_KEY`, and `DATABASE_URL`, then run `pnpm trigger:dev`. Deploy
with `pnpm trigger:deploy` only after the deployment composition root registers
the trusted task handler and supplies the Managed Agents, R2, verifier,
publication-authority, and publisher adapters. The repository intentionally
does not invent those credentials or perform a live deployment.

`CRON_SECRET` must be 32–256 bytes and protects both internal reconciliation
and retention routes. Never expose Trigger secrets, waitpoint callback URLs, or
public waitpoint tokens to browser DTOs or logs.
