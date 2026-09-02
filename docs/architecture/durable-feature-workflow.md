# Durable feature workflow

The feature workflow turns one durable feature run into a tested draft pull
request. Trigger.dev coordinates execution, but Postgres remains authoritative
for runs, approval decisions, step outputs, usage, side-effect claims, and
session leases.

## Execution path

1. Configuration apply resolves and persists the selected repository's exact
   default-branch head through a separate contents-read-only GitHub App
   identity. The configuration response exposes the immutable, non-secret
   provenance needed by the API/CLI feature-start request.
   `POST /api/features` creates the idempotent `pending` domain run bound to
   that revision. A durable outbox effect then reads the exact base commit,
   validates and writes a bounded `source/bundle-v1` artifact, and only then
   requests the versioned Trigger task.
2. The specification role writes a separately hashed specification plus
   `definition-of-done-v2` with one `test/acceptance/<id>.test.mjs` per
   criterion.
3. The workflow creates a scope hash over the run, configuration, specification,
   and DoD. It stores a domain approval and a Trigger waitpoint reference. The
   waitpoint is only a wake signal; after waking, the task re-reads the consumed
   approval and its atomic `approval.approved` or `approval.rejected` event.
   The inbox shows the acceptance test file bodies.
4. Planning, implementation/testing, review, and trusted verification use
   distinct agents, environments, and runtime sessions. Each role receives the
   exact source bundle (at most one MiB for the current POC runtime transport)
   plus verified upstream artifacts as read-only mounted
   files. Its Artifact MCP capability can write only to that role's logical
   step scope. A requested fix gets one fresh
   implementation session followed by a fresh final-review session; a final
   `changes_requested` decision cannot publish.
5. After implementation, trusted code seals the acceptance test files onto the
   change set (`sealed-changes`). Verification materializes the sealed set and
   runs the allowlisted project command and `node --test 'test/acceptance/*.test.mjs'` in a
   separate, secretless Managed sandbox with only source/change inputs and Bash.
   An implementer change under `test/acceptance/` is a permanent error. It can
   reach only server-configured package registry hosts; lifecycle scripts are
   disabled. The provider-observed exact install/test sequence and result are
   bound into a signed, bounded report.
6. Trusted code verifies bounded artifact schemas, tests, DoD evidence, and
   protected-path policy. A trusted publication authority—not an agent—creates
   the publisher input. The GitHub App publisher revalidates the stale base and
   creates only a draft PR.

No runtime request contains GitHub App, branch-push, merge, or publication
credentials. Agent outputs are bounded JSON results containing artifact
manifests, and reasoning is not persisted.

Two operator-facing exceptions are deliberate, because a feed that says only
"the model sent a message" cannot explain the failure it is describing. A
step's progress notes carry the model's message text, and its completed note
carries the step's schema-validated result with artifact manifests summarized.
Both are stripped of control characters, collapsed to one line, and bounded,
so neither can forge feed structure or flood the run page. Both are
provider-influenced text: read them as something the model said, never as
instruction.

Local experiment projects (`project.localPath` instead of
`project.repository`) swap only the two edges of the pipeline: source
bundles are built from a local git repository inside
`AGENTOS_LOCAL_WORKSPACES_ROOT` (containment-checked, plumbing-only git),
and publication becomes a commit on a new `agentos/<run>` branch in that
repository, created with `hash-object`/`mktree`/`commit-tree`/`update-ref`
so hooks never run and the operator's working tree is never touched. The
publication authorization carries the distinct audience
`local-git-publisher`, and the local repository identity is a separate
schema variant with no installation or repository IDs, so local manifests
are structurally incapable of reaching the GitHub publisher (and vice
versa). Everything between the edges — sessions, artifact MCP, budgets,
approvals, sealed verification — is byte-identical to the GitHub path.

## Chained runs

A feature run may name `baseRunId`: a succeeded run in the same project whose
published commit it builds on, so feature N+1 does not wait for the operator
to merge feature N.

The caller names a run, never a SHA. `createRun` reads the base run's own
outcome for the branch and commit it published (`publishedBranch` /
`publishedCommitSha`, recorded by the workflow from the publisher's result)
and writes the resolved edge onto the immutable run input as
`chain: { baseRunId, baseBranch, baseCommitSha }`.

`provenance.repositorySha` keeps its meaning — the applied configuration
revision's SHA — and every existing assertion runs against it unchanged,
including the dispatch-time snapshot check. The chain redirects exactly two
things: the SHA source ingestion resolves, and the `expectedBase` the
publication manifest names. So a chained run publishes onto its base's
branch, the draft PR shows that feature's diff alone, and the branch stack
accumulates until the operator merges the last one.

Creation refuses, each with its own code: a base that is missing,
unfinished, or another project's (`base_run_unavailable`); a base that
recorded no published commit — a draft PR whose publisher reported no
`commitSha` is unchainable rather than chained to a guess
(`base_run_unpublished`); a base that ran under a different configuration
revision (`chain_configuration_changed`); a base another active run already
builds on, since a chain is a line and not a tree (`chained_base_taken`);
and a chain longer than `config.chains.maxDepth`, default three
(`chain_too_deep`).

A base branch that moved underneath a chained run hits the existing
stale-base check at publication and fails without a partial write. The
system still never merges: the stack is the operator's to land.

## Backlogs

A backlog is an ordered list of feature requests bound to a project. The
operator writes it once; the system runs the items one at a time, each
chained onto the last.

`advanceBacklog` (`packages/core/src/backlog.ts`) is the whole scheduler as
one pure function over durable state: given a backlog, its items in order,
and the runs those items produced, is there an item to start now and on what
base? Reconciliation calls it per project _after_ its run scan — an item's
run may have just been settled by that scan — and acts on the answer:
dispatch through the ordinary `createFeatureRun` with `baseRunId`, complete
the backlog, or pause it.

Pause is the only failure mode. A run that fails, is cancelled, or publishes
nothing to build on stops the backlog with that reason; so does any refusal
from run creation, whose error code becomes the reason. The backlog never
retries, never skips an item to keep going, and never dispatches past a
non-success. Resuming is an explicit operator act.

The chain depth bound is the release valve: when a stack reaches
`config.chains.maxDepth`, the next dispatch would be refused, the backlog
pauses, and the operator merges to continue. An unmerged stack of five
features is five features' worth of conflict surface and review debt, and
the bound is where the project said to stop.

Two reconciliation passes over the same state start nothing twice: the
dispatch idempotency key is `backlog:<id>:item:<ordinal>` and the attach of
a run to an item is a CAS, backed by a `unique(run_id)` index.

## Replay and failure model

`workflow_effects` records a fingerprint before every Trigger, runtime,
waitpoint, cleanup, or publisher side effect. Each delivery owns a versioned,
expiring fencing lease; only that owner may attach an external reference or
complete/fail the effect. Replaying the same key with different input is a
conflict. Completed effects return their prior result. Trigger task starts,
waitpoint completion, and draft publication are safe to retry through their own
idempotency contracts.

A runtime start that is durably marked `started` but has no external reference
is repeatedly reconciled by the provider's deterministic
run/step/idempotency binding. The sealed start inputs are reconstructed from
the immutable step/config/access checkpoints. If no session is discoverable by
the reservation's bounded reconciliation deadline, two successful absence
observations separated by at least 30 seconds are required. Only then does
trusted cleanup remove uploaded files and vaults, conservatively charge the
full reservation, and release the global fence. Provider/list errors never
count as absence observations.
Managed Agents session listing reconstructs the same HMAC-derived ownership
capability across replicas. Publication retries re-enter the composite GitHub
publisher's durable reconciliation. Full runtime handles are AES-GCM sealed in
Postgres with run/step/source/config AAD; neither DTOs nor logs receive the
capability. Cancellation rehydrates that handle and independently persists and
retries runtime-session and Trigger-run cancellation effects, so one provider
failure cannot suppress the other. Cleanup is a separate durable effect and is
reconciled after process termination.

The bounded control-plane sweep persists its run cursor in Postgres, so a
terminated invocation resumes beyond its last scanned run instead of starving
the tail. It also CAS-fails active feature runs once their
absolute 60-minute domain deadline passes, expires any still-pending scoped
approval, and redelivers cancellation plus cleanup. Expired spend reservations
retain the global fence until reconciliation has cancelled and cleaned the
remote session. The reconciler prices observed usage through the exact stored
model/rate configuration digest when available and otherwise charges the full
reservation before releasing the fence, so a killed worker cannot silently
erase paid usage or admit a second paid session.

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
- approvals wait up to 24 hours (`approvalTtlMs`); the 60-minute execution
  budget starts when the spec/DoD approval is consumed;
- a run in `waiting` with a live approval is not failed for the execution
  deadline;
- a goal parent with a non-terminal child is not failed for the execution
  deadline;
- at most three runs in a chain (`config.chains.maxDepth`), and one active
  run per base;
- $2 per workflow and $5 per rolling 24-hour project window, represented as
  integer microdollars;
- no new session at 80% of either cap.

The PostgreSQL admission function takes an advisory transaction lock, recomputes
usage from `usage_records`, includes all active estimated reservations, applies
both thresholds, and atomically writes the reservation plus global lease before
runtime start. Every terminal path collects actual usage or conservatively
charges the reservation before settlement. Schema/provider failure and
cancellation therefore cannot silently release uncharged capacity. Usage
records persist ordinary input/output, cache reads, distinct 5-minute and
1-hour cache-creation buckets, runtime, and the pricing algorithm/config
version. Integer-safe ceiling prices every bucket; undifferentiated legacy
cache creation is conservatively charged at the 1-hour rate. Trigger
queue concurrency is defense in depth; it is not the budget or concurrency
authority.

## Executors

The workflow engine imports nothing from Trigger.dev. `createDurableFeatureWorkflow`
takes ports, and only one of them -- the approval waiter -- is Trigger-shaped.
Two executors therefore drive the same engine, selected by `AGENTOS_EXECUTOR`:

- **`trigger`** (default when `TRIGGER_SECRET_KEY` is set): the deployed shape.
  Trigger.dev coordination, Managed Agents sessions, R2 artifacts, an artifact
  MCP served over public HTTPS.
- **`local-direct`**: everything in the control-plane process. Sessions run in
  the process sandbox against the model API directly, artifacts are files under
  `AGENTOS_LOCAL_STATE_DIR`, the artifact MCP is a function call, and approvals
  wake by polling the approval row. Local projects only; a GitHub-bound project
  is refused by name.

Setting both is a boot error: two executors could claim one run.

This is one composition with a `profile` parameter, not two compositions. What
decides whether a change is safe -- role isolation, budget admission, the
sealed acceptance tests, the signed trusted-test-report, the publication
authority -- is the same code on both paths, so it cannot drift. What differs
is only how work is scheduled and where bytes live.

Two consequences worth stating plainly. Verification may run on the process
runtime because the local profile supplies a workdir-relative trusted command;
the container-absolute one (`exactTrustedCommand`) still may not, because
`rm -rf /workspace/repo` outside a container is a real directory on the host.
And a local session does not survive a process restart: the dispatcher answers
`COULD_NOT_FIND_EXECUTOR` for an execution it no longer holds, which is what
the existing recovery paths already understand.

## Previewing what a run delivered

A finished local run leaves an `agentos/<run>` branch. Reading a diff answers
whether the change looks right; it does not answer whether the thing runs.

```sh
pnpm preview <runId> [--port 4173] [--script dev]
```

It reads the run's own outcome for the branch and repository, checks the
branch out detached in a scratch worktree, installs, and starts whatever
dev/start script the project declares, printing the URL. A project with no
such script gets its checkout left in place with the command to run its tests
and the command to discard it. Ctrl+C stops the server and removes the
worktree; the operator's own checkout is never touched and the branch is never
moved.

This runs model-written code on the operator's machine, outside the sandbox
the pipeline keeps it inside. The run's sealed verification has already run
the project's suite and the frozen acceptance tests in that sandbox, so this
is for looking at the result rather than for deciding whether it is safe.
A GitHub-bound run has nothing to preview locally: its result is a draft pull
request.

## Local verification

Install dependencies, apply migrations, and run the no-cost contract suite:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm db:check
```

Set `TEST_DATABASE_URL` to include the PostgreSQL checkpoint/admission contract
in `pnpm test:integration`. Normal CI uses fake Trigger, runtime, artifact, and
publisher boundaries and makes no paid model or cloud calls.

For Trigger.dev local development, set `TRIGGER_PROJECT_REF`,
`TRIGGER_SECRET_KEY`, and `DATABASE_URL`, then run `pnpm trigger:dev`. The task
registers a lazy, fail-closed production handler at module load.
`createProductionFeatureWorkflowFromEnv` wires Neon domain/checkpoint stores,
R2 plus its durable manifest, Managed Agents, scoped Artifact MCP vaults, the
isolated command-observation verifier, publication authorization, and the
composite GitHub publisher. Repository code is materialized and tested only in
the limited verification sandbox; it is never executed in the secret-bearing
Trigger worker. The control plane uses the same Neon repository and
handle-sealing key for cancellation reconciliation. Missing secrets fail only
when execution needs the component, never silently during Trigger discovery.

Production feature configuration must contain exact `specification`,
`planning`, `implementation`, `review`, and `verification` step IDs, each with
a separate limited-network environment. The first four may use only the
`artifacts` MCP alias. Verification must be Bash-only with no MCP, configured
variables, or YAML-selected network/package capabilities. Trusted server
configuration supplies its exact package-registry host allowlist. Managed
Agents' broad package-manager registry bypass remains disabled; `pnpm` reaches
only those explicit hosts for the frozen-lockfile install.
Source ingestion additionally requires the distinct
`GITHUB_READER_APP_ID`, `GITHUB_READER_APP_PRIVATE_KEY`, and
`GITHUB_READER_SELECTED_REPOSITORIES_JSON`; the reader App ID must differ from
the publisher App ID. Required
server-only values include `AGENTOS_ARTIFACT_MCP_URL`,
`ARTIFACT_CAPABILITY_KEYS_JSON`, `AGENTOS_TEST_REPORT_KEYS_JSON`, and the
runtime/R2/GitHub credentials documented in `.env.example`.

Migration `0016_complete_usage_pricing.sql` intentionally retains defaults for
its new usage columns so version-locked older Trigger deployments can finish
writing during the expand phase. A later contract migration may remove those
defaults only after old task versions and waitpoints have drained. Migration
`0017_restore_usage_defaults.sql` also restores them for databases that applied
the earlier development form of `0016` before the expand-phase correction.

`CRON_SECRET` must be 32–256 bytes and protects both internal reconciliation
and retention routes. Never expose Trigger secrets, waitpoint callback URLs, or
public waitpoint tokens to browser DTOs or logs.
