# Bounded Goal Loop Design

## Objective

Add a production-composed goal workflow that can make at most three bounded
attempts through the existing feature workflow, evaluates operator-supplied
Definition-of-Done criteria using signed trusted evidence, persists replayable
progress, and exposes that progress through the control plane and CLI.

## Scope

The first goal-loop version supports command criteria only. This is the one
criterion type for which the existing feature workflow already produces
independently observed, signed evidence. Artifact, pull-request-check, and human
criteria remain valid core concepts but are rejected by the goal-start HTTP
contract until equally trusted verifiers exist.

The workflow never merges or deploys code. Each goal attempt delegates to the
existing feature workflow boundary and can create only a draft pull request.
The goal stops immediately after all required criteria pass. Failed attempts
may retry from the immutable configured repository revision, but a fourth
attempt is impossible.

## Operator contract

`POST /api/goals` retains the existing title, description, project, repository
SHA, and configuration digests. It additionally requires `criteria`, containing
one to twenty strict command criteria:

```json
{
  "id": "tests",
  "type": "command",
  "description": "The repository test suite passes",
  "command": "pnpm test",
  "required": true
}
```

Criterion IDs are unique within the request. Commands are keys in the existing
trusted test-command allowlist, not shell strings executed directly by the
goal coordinator. The CLI accepts the same array through `--criteria-json` so
HTTP and CLI behavior remain equivalent.

Goal creation fails closed unless every supplied provenance digest and the
repository SHA match one applied configuration revision. It persists the same
immutable configuration snapshot used by feature runs and creates deterministic
criterion records. Replaying the same idempotency key is harmless; changing the
request conflicts.

## Core state machine

`packages/core/src/goal-workflow.ts` owns a pure reducer. Its state contains the
immutable criteria, `maxSteps` (one through three), current step, latest result
per criterion, failure fingerprints, terminal reason, and processed-event
fingerprints.

The reducer accepts start, step-evaluated, cancel, and crash events. A
step-evaluated event must contain exactly one result for every criterion. It:

1. succeeds when all required criteria pass;
2. fails as `stuck` when a signed verifier reports the same failure fingerprint
   three times;
3. fails as `step_limit` when the third step remains unsatisfied; or
4. advances to the next step.

Duplicate event IDs with the same fingerprint are ignored. Reusing an event ID
with different content, skipping a step, modifying criteria, or transitioning a
terminal state fails closed.

`AgentOsConfig.goals.maxSteps` is constrained to one through three. Starter and
example configuration use three.

## Durable records

`goal_criteria` stores the canonical command criterion definition alongside its
description. `goal_progress` gains a required step ordinal constrained to one
through three. Deterministic progress IDs make retries idempotent. One run-level
progress entry records the child feature run for a step; criterion-level entries
record trusted verification outcomes.

Repository implementations expose idempotent criterion/progress writes. A
replay must return the existing equivalent value and reject conflicting input.
PostgreSQL, generated query, in-memory, and repository-parity tests cover the
same contract.

The authoritative run remains the terminal summary. Its sanitized output
contains only status, completed/maximum steps, criterion statuses, child run
IDs, draft pull-request URL when present, and a bounded failure reason. Raw
reports, credentials, and model output never enter the projection.

## Trusted evaluation

The feature workflow already stores one `trusted-test-report` artifact whose
evidence is covered by an HMAC `trusted-test-report` attestation. The goal
command verifier:

- loads exactly one report from the child run's verification scope;
- recomputes the canonical evidence digest;
- verifies the report attestation's kind, subject, run binding, and digest;
- requires the observed command to match the goal criterion;
- requires an observed zero exit code and sane timestamps; and
- issues a separate domain-separated `definition-of-done-verification`
  attestation consumed by the existing core `verifyCriterion` function.

Production reuses the rotating `AGENTOS_TEST_REPORT_KEYS_JSON` secrets with a
different attestation kind. HMAC kind separation prevents a test report from
being accepted directly as a DoD result.

## Goal-step execution

`createDurableGoalWorkflow` depends on a narrow `GoalStepRunner`. Before every
step it writes a deterministic run-level progress checkpoint. The production
runner creates a deterministic child feature run, copies the parent source
bundle into the child's source scope, copies the immutable configuration
snapshot, and invokes the existing `FeatureWorkflowTaskHandler` with the child
run. Terminal child runs make the operation replay-safe.

On child success, the runner loads the trusted test report and submits it as
evidence for each command criterion. A failed child produces deterministic
failed results and can consume another bounded step. The next child request
includes only safe prior failure summaries.

Parent cancellation also transitions every recorded active child run to
cancelled and delivers the existing runtime/Trigger cancellation outbox for the
child. The workflow checks the authoritative parent before and after every
child execution, so cancelled goals cannot publish later attempts.

## Trigger and reconciliation

A separate versioned Trigger task, `agentos-goal-workflow-v1`, registers beside
the feature task. Start requests carry their pipeline; the durable outbox first
ingests the immutable source bundle, then dispatches the matching task with the
same fenced side-effect semantics.

Pending goal runs are durable outbox intents. Reconciliation repairs a missing
goal snapshot/criterion set from the immutable run input, then redelivers the
goal task. Goal runs use the configured timeout capped by the existing absolute
one-hour workflow boundary. Terminal goals reuse cleanup and cancellation
reconciliation.

## Read model

Goal run projections add a bounded `goal` object with maximum/current steps,
criteria, latest results, and child run summaries. Existing run endpoints and
the run page consume this optional projection. `agentos runs show` renders the
same JSON, while `agentos goal show` provides an explicit alias.

## Verification

All default tests remain credential-free. Required gates are core reducer tests,
repository parity, migration/schema checks, trusted-verifier negative tests,
fake durable workflow tests, task/outbox/reconciliation tests, HTTP/CLI tests,
typecheck, lint, build, and Playwright. PostgreSQL integration runs when
`TEST_DATABASE_URL` is available. R2, Managed Agents, Trigger deployment, and a
draft-PR canary remain explicit live gates because they require operator-owned
credentials and create external state.
