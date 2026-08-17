# Durable goal workflow

The goal workflow turns one durable goal run into at most three bounded
attempts through the existing feature workflow. Operators supply deterministic
Definition-of-Done command criteria; the workflow evaluates them only against
signed, independently observed evidence and stops immediately once every
required criterion passes. It never merges or deploys; each attempt can create
only a draft pull request through the existing trusted publication boundary.

## Bounded state machine

`packages/core/src/goal-workflow.ts` owns a pure reducer. State contains the
immutable criteria, `maxSteps`, the current step, the latest result per
criterion, failure fingerprints, and processed-event fingerprints.
`AgentOsConfig.goals.maxSteps` is constrained to one through three, so a fourth
attempt is unrepresentable rather than merely discouraged.

The reducer accepts start, step-evaluated, cancel, and crash events. A
step-evaluated event must carry exactly one result for every criterion. The
run succeeds when all required criteria pass, fails as `stuck` when a signed
verifier reports the same failure fingerprint three times, fails as
`step_limit` when the third step remains unsatisfied, and otherwise advances.
Canonical SHA-256 event fingerprints make an exact duplicate event a no-op,
while reusing an event ID with different content, skipping a step, mutating
criteria, or transitioning a terminal state fails closed.

## Immutable provenance and durable records

`POST /api/goals` accepts one to twenty strict command criteria with unique
IDs. Commands are keys into the existing trusted test-command allowlist
(`AGENTOS_TRUSTED_TEST_COMMANDS_JSON`), never shell strings executed by the
coordinator: creation rejects any criterion whose command is not an allowlist
key and fails closed when the allowlist itself is not configured. Goal
creation also fails closed unless every supplied provenance digest and the
repository SHA match one applied configuration revision; it persists the same immutable configuration snapshot
used by feature runs, stores the criteria inside the immutable run input, and
creates deterministic `goal_criteria` records holding each canonical
definition. `goal_progress` rows carry a step ordinal that a database check
constrains to one through three. Both repositories expose idempotent
criterion/progress writes: replaying an equivalent record returns the existing
row and conflicting input is rejected.

Because pre-existing goal rows predate signed evidence, migration
`0018_bounded_goal_records` fails any still-active legacy goal run with the
bounded error `legacy_goal_unverifiable` and deletes legacy criterion and
progress rows instead of guessing their provenance.

## Signed command evidence

The feature workflow already stores one `trusted-test-report` artifact whose
evidence is covered by an HMAC attestation. `createTrustedGoalCommandVerifier`
loads exactly one report from the child run's verification scope, recomputes
the canonical evidence digest, and verifies the attestation kind, subject, run
binding, and digest. The criterion's command must equal the signed report's
test-evidence command key — the same allowlist key the feature workflow
resolved into the exact sandbox invocation it then observed — and the
observation must show a zero exit code with orderly timestamps before the
verifier issues a separate
domain-separated `definition-of-done-verification` attestation consumed by the
core `verifyCriterion` function. Both authorities reuse the rotating
`AGENTOS_TEST_REPORT_KEYS_JSON` secrets; HMAC kind separation prevents a raw
test report from being replayed as a DoD verdict. Any failure produces a
deterministic failure fingerprint that feeds stuck detection.

## Durable execution and replay

`createDurableGoalWorkflow` reconstructs reducer state by replaying persisted
progress, writes a deterministic run-level child checkpoint before every
attempt, and CAS-transitions the authoritative parent run. The same
`validateDurableGoalInputs` gate runs at task entry, inside reconciliation,
and before durable execution: it parses the immutable run input with a strict
schema, requires exactly one configuration snapshot bound to the run and its
configuration revision, recomputes every provenance digest (configuration,
model, prompt, environment, and publication policy) from the snapshot's
configuration, and requires each stored criterion record to match the
canonical run-input definition ordinal by ordinal. Malformed authoritative
state is never repaired in place; the goal fails closed instead of dispatching
a child from untrusted input.

Child feature runs use the deterministic ID
`sha256(parentRunId, step)`, so retries are replay-safe: a terminal child is
consumed rather than re-executed. The step runner copies the parent's
immutable source bundle and configuration snapshot into the child scope and
invokes the existing production feature handler; the next attempt receives
only bounded prior-failure summaries. The workflow checks the authoritative
parent before and after every child execution, so a cancelled goal cannot
publish a later attempt. Parent cancellation also transitions every recorded
active child and delivers the existing runtime/Trigger cancellation outbox for
it.

Reconciliation treats goal-owned children as owned state: a pending feature
run whose idempotency key, deterministic ID, goal-pipeline parent, and
recorded child checkpoint all match is skipped by standalone feature dispatch,
so a goal child can never start outside its parent's coordination.

## Dispatch and reconciliation

The versioned Trigger task `agentos-goal-workflow-v1` registers beside the
feature task on its own single-concurrency queue, and start requests carry
their pipeline so outbox fingerprints stay pipeline-bound. Pending goal runs
are durable outbox intents: reconciliation repairs a missing snapshot or
criterion set only from the immutable run input, then redelivers the task.
Goal input that fails strict validation is counted as a failure and never
repaired or dispatched, while the sweep cursor still advances past it. Goal
runs use the configured `goals.timeoutMs` capped by the absolute one-hour
workflow boundary, and terminal goals reuse the existing cleanup and
cancellation reconciliation.

The production composition stays lazy: Trigger task discovery loads no
secret-bearing adapters, and the first execution resolves Neon, the R2
artifact store (`CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ARTIFACT_BUCKET`,
`CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID`,
`CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY`), the rotating
`AGENTOS_TEST_REPORT_KEYS_JSON` verifier keys, and the complete production
feature handler with its existing environment contract.

## Read model and delivery surfaces

Run projections add an optional bounded `goal` object: maximum and current
steps, criterion IDs/descriptions/required flags, latest per-criterion results
limited to step, status, and a bounded code, and at most three child summaries
with run ID, status, and draft pull-request URL. Raw reports, attestations,
credentials, and model output never enter the projection. The run page renders
this projection, and the CLI reaches parity through `--criteria-json` (strict
JSON, one to twenty command criteria, rejected on feature start) plus
`agentos goal show`, which renders readable text and stable JSON from the same
run endpoint.

## Verification boundary

All default goal-loop gates run without credentials: core reducer tests,
repository parity, migration and schema checks, trusted-verifier negative
tests, fake durable workflow and runner tests, task/outbox/reconciliation
tests, HTTP/CLI tests, typecheck, lint, build, and Playwright. PostgreSQL
integration runs when `TEST_DATABASE_URL` is present. Trigger deployment, R2,
Managed Agents, and a live draft-PR canary remain explicit live gates because
they require operator-owned credentials and create external state.
