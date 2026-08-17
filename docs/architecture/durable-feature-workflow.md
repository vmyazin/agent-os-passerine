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
   implementation session followed by a fresh final-review session; a final
   `changes_requested` decision cannot publish.
5. Trusted code verifies bounded artifact schemas, tests, DoD evidence, and
   protected-path policy. A trusted publication authority—not an agent—creates
   the publisher input. The GitHub App publisher revalidates the stale base and
   creates only a draft PR.

No runtime request contains GitHub App, branch-push, merge, or publication
credentials. Agent outputs are bounded JSON results containing artifact
manifests; raw reasoning and secrets are not persisted as domain events.

## Replay and failure model

`workflow_effects` records a fingerprint before every Trigger, runtime,
waitpoint, cleanup, or publisher side effect. Each delivery owns a versioned,
expiring fencing lease; only that owner may attach an external reference or
complete/fail the effect. Replaying the same key with different input is a
conflict. Completed effects return their prior result. Trigger task starts,
waitpoint completion, and draft publication are safe to retry through their own
idempotency contracts.

A runtime start that is durably marked `started` but has no external reference
is reconciled by the provider's deterministic run/step/idempotency binding.
Managed Agents session listing reconstructs the same HMAC-derived ownership
capability across replicas. Publication retries re-enter the composite GitHub
publisher's durable reconciliation. Full runtime handles are AES-GCM sealed in
Postgres with run/step/source/config AAD; neither DTOs nor logs receive the
capability. Cancellation rehydrates that handle, cancels the paid session before
Trigger, and persists cleanup effects for bounded reconciliation after process
termination.

The bounded control-plane sweep also CAS-fails active feature runs once their
absolute 60-minute domain deadline passes, expires any still-pending scoped
approval, and redelivers cancellation plus cleanup. Expired spend reservations
are conservatively charged at their reserved amount before their global session
lease is released, so a killed worker cannot silently erase paid usage.

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
usage from `usage_records`, includes all active estimated reservations, applies
both thresholds, and atomically writes the reservation plus global lease before
runtime start. Every terminal path collects actual usage or conservatively
charges the reservation before settlement. Schema/provider failure and
cancellation therefore cannot silently release uncharged capacity. Trigger
queue concurrency is defense in depth; it is not the budget or concurrency
authority.

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
`TRIGGER_SECRET_KEY`, and `DATABASE_URL`, then run `pnpm trigger:dev`. The task
registers a lazy, fail-closed production handler at module load.
`createProductionFeatureWorkflowFromEnv` wires Neon domain/checkpoint stores,
R2 plus its durable manifest, source-bundle materialization, Managed Agents,
the trusted command executor/verifier, publication authorization, and the
composite GitHub publisher. The control plane uses the same Neon repository and
handle-sealing key for cancellation reconciliation. Missing secrets fail only
when execution needs the component, never silently during Trigger discovery.

`CRON_SECRET` must be 32–256 bytes and protects both internal reconciliation
and retention routes. Never expose Trigger secrets, waitpoint callback URLs, or
public waitpoint tokens to browser DTOs or logs.
