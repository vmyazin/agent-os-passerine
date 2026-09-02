# Local Direct Runtime

Status: Draft for operator approval
Date: 2026-09-02
Approach: compose the existing in-process pieces behind the existing ports; add
nothing to the workflow engine

## Context

Between 2026-08-17 and 2026-08-28 the control plane recorded 101 feature runs.
Four succeeded: two are e2e seed fixtures and two are one-line "greet" probes.
Twenty-three attempts at one small dogfood change on this repository ("Rename
Setup copy to Start Work") all failed or were cancelled, and one stayed in
`running` for five days after both implementation attempts had failed.

The failures do not share a cause. They are spread over about eighteen
distinct errors, each at a different runtime boundary: the `usage_records`
insert during settlement (20 runs), the 60-minute deadline (13), a model
answering in prose instead of the required JSON (about 12), the $2 per-run
budget (7), a mounted access file over the Managed Agents 1 MiB ceiling, Kimi
502s, an orphaned session, `wait.forToken` called outside a Trigger task, and
a configuration that named an unbuilt runtime.

Today one run crosses six boundaries: the Next.js control plane, Neon, a local
`trigger dev` worker, Managed Agents or the Kimi provider, an ngrok tunnel that
exposes the Artifact MCP to the cloud session, R2, and finally git. The
credential-free test suite (70K lines) mocks every one of those boundaries, so
`main` is green while every real run fails. The threat model that justifies
those boundaries is a hosted multi-tenant product. The operator is one person
on one machine.

Research for this design established three facts that make the change small:

1. `packages/adapters/src/trigger/workflow.ts` has **no `@trigger.dev` import**.
   `createDurableFeatureWorkflow(deps)` (`workflow.ts:1429`) takes
   `DurableFeatureWorkflowDependencies` (`trigger/types.ts:386-445`), and the
   only Trigger-shaped dependency is `approval: WorkflowApprovalWaiter`. The
   `execution` field only names the execution owner. The Trigger SDK is
   imported by exactly three files: `trigger/task.ts`, `trigger/goal-task.ts`,
   `trigger/trigger-adapter.ts`.
2. The Kimi provider (`packages/adapters/src/kimi/`) already runs the agent
   loop in this process against an Anthropic-compatible Messages API
   (`transport.ts:93` posts to `{baseUrl}/v1/messages` with `x-api-key` and
   `anthropic-version`), executes tools in a path-confined local sandbox, and
   implements `observeCommand` locally. Its only network hop besides the model
   is the Artifact MCP call (`kimi/provider.ts:853 callArtifactMcp`), and
   `validateHttpUrl` (`provider.ts:984`) already accepts plain `http` on
   localhost.
3. The local-git edges exist and are selected today by `project.localPath`:
   `createLocalSourceSnapshotIngestor` (`local-git/source-snapshot.ts:105`)
   and `createLocalGitPublisher` (`local-git/publisher.ts:366`). The
   in-process test fixture in `trigger/workflow.test.ts:200-345` already
   drives the whole pipeline with `InMemoryDomainRepository`,
   `createInMemoryArtifactStorage`, `InMemoryWorkflowCheckpointStore` and an
   inline approval waiter. `createFeatureGoalStepRunner`
   (`trigger/goal-feature-runner.ts:299`) is a production path that already
   runs the feature task handler in-process with no Trigger dispatch.

## Goal

A local-mode project runs a feature end to end inside the control-plane
process: no Trigger.dev, no Managed Agents, no ngrok, no R2. Model calls go
straight from this machine to the model API. Sessions execute in the existing
process sandbox. Artifacts live on local disk. Approvals wake by a database
poll. The run page, inbox, budgets, signed verification evidence and
local-branch publication behave exactly as they do today.

Exit gate, from the 2026-09-02 evaluation: the "Rename Setup copy to Start
Work" feature succeeds on this repository, started from the project page,
three times in a row, each in under fifteen minutes, with every failure along
the way naming its cause on the run page.

## Non-goals

- Replacing Postgres. The repository stays Neon or `memory` as configured.
  Embedding Postgres (PGlite) is a separate decision.
- Changing the pipeline shape. The five-role rule in
  `trigger/production-composition.ts:53` stays; a two-step pipeline is the
  next spec.
- Structured output through tool calls for the Managed Agents path. The
  process runtime already uses a `submit_result` tool.
- Goal runs. The local executor refuses `startGoal` with a permanent, named
  error; goal support is a follow-up once feature runs are reliable.
- Running the executor in a separate worker process. v1 runs inside the Next
  server. If dev-server reloads prove disruptive, a `agentos worker`
  process that polls pending runs is the follow-up, and nothing in this
  design prevents it.
- Container or VM isolation for the sandbox. The process sandbox limits stated
  in `docs/architecture/kimi-runtime.md` stand unchanged.
- Prompt caching, streaming, or any transport feature beyond what the Kimi
  transport sends today.
- Any change to the GitHub path, the Trigger path, or the Managed Agents
  provider. Both executors coexist; the environment selects one.

## Design

### Selection

A new server-only variable `AGENTOS_EXECUTOR` with values `trigger` (default
when `TRIGGER_SECRET_KEY` is set) and `local-direct`. `workflowDispatchFromEnv`
(`apps/control-plane/src/application/runtime.ts:471`) currently returns
`undefined` when `TRIGGER_SECRET_KEY` is absent. It gains a second branch: when
`AGENTOS_EXECUTOR=local-direct`, it builds the same `createDurableTriggerOutbox`
with a local dispatcher and a local approval waiter in place of the Trigger
ones. Setting both `local-direct` and `TRIGGER_SECRET_KEY` is a configuration
error that fails at boot, so the two executors can never race for one run.

The outbox, effects ledger, reconciliation loop, budget admission, cancellation
and cleanup are reused as they are. Everything below the outbox is what changes.

### Local dispatcher

`createLocalDirectDispatcher(options)` in
`packages/adapters/src/local-direct/dispatcher.ts` implements
`TriggerWorkflowDispatcher` (`trigger/trigger-adapter.ts:120-135`) so the
outbox does not know which executor it has.

- `startFeature(runId, projectId, attempt, resumeGeneration)` records an
  in-memory execution `{runId, generation, status: 'executing', startedAt}`,
  returns the reference `local-direct:<runId>:<generation>`, and schedules
  `handler.run({version: 'feature-task-payload-v1', runId}, execution)` on the
  next tick, where `handler` is the feature task handler built by the local
  composition (below) and `execution` is
  `{taskVersion: 'local-direct', deploymentVersion: <git HEAD or 'dev'>,
triggerRunId: <the reference>}`. A `FeatureWorkflowTaskTransientError` is
  retried once after a bounded delay, mirroring `task.ts` retry policy. Any
  other error marks the execution `failed` with the error message; the
  workflow has already written the run's terminal state itself.
- `startGoal` throws a permanent error naming the limitation.
- `retrieve(ref)` returns the recorded execution status. A reference that is
  not in the map (the process restarted) returns `{status: 'lost'}`; the
  outbox's `isExecutorUnavailable` check treats it like an unreachable
  executor, which is the truthful description.
- `cancel(ref)` aborts the execution's `AbortController`. The workflow's own
  cancellation path (`requestCancel` in `trigger/outbox.ts:464`) still cancels
  the runtime session first; this only stops the driver loop.

Concurrency is one execution at a time per process. The budget admission
function remains the authority (`agentos_admit_workflow_session`), as the
durable-workflow runbook already states; the dispatcher's limit is only a
guard against a runaway loop.

### Restart recovery

Trigger re-attaches to a running task after a worker restart. This driver
cannot, and a lost in-flight run is exactly the five-day `running` run the
evaluation found. On construction the dispatcher therefore lists runs in
`running` or `waiting` whose workflow effects carry an `ownerId` beginning
with `workflow:local-direct:` (the `executionOwner` string the workflow derives
at `workflow.ts:1441` from `execution.triggerRunId` and `taskVersion`, and
stores on every claimed effect), and for each one calls the resume path
introduced on branch `fix/pipeline-reliability-and-resume`:
`checkpoints.releaseRunForResume(runId)`, transition to `pending`, then
`requestStart` with the next generation. A run in `waiting` replays its
succeeded effects, reaches the approval step, and blocks on the local waiter
again with no model spend. **This design depends on that branch being merged
first.**

### Local approval waiter

`createLocalApprovalWaiter({repository, clock, pollIntervalMs})` in
`packages/adapters/src/local-direct/approval-waiter.ts` implements
`WorkflowApprovalWaiter` plus `wake(id)`:

- `create({idempotencyKey, timeout, tags})` derives the approval id from the
  effect key the workflow already uses (`waitpoint:<runId>:<approvalId>`) and
  returns `{id: 'local-approval:<approvalId>'}`. No external state.
- `wait(id)` resolves when the approval row is `consumed`
  (`{status: 'completed'}`) or `expiresAt` has passed
  (`{status: 'timed_out'}`), checking on `wake` and on a poll every five
  seconds. It returns nothing else. The workflow then re-reads the decision
  from the database exactly as today (`workflow.ts:1390
getAuthoritativeApproval`), so the waiter cannot forge an approval.
- `wake(id)` is called by `requestApprovalResume` (`outbox.ts:440`) and
  resolves the pending wait immediately.

A wait that survives a process restart is re-entered by the recovery path
above, not by the waiter.

### Process runtime provider

The Kimi provider is generalized into the process runtime without moving code.

- `RuntimeAgent` (`packages/core/src/ports.ts:6`) gains an optional
  `modelProvider?: string`, filled by the production handler from the agent's
  model profile `provider` field. Every existing provider ignores it.
- `createKimiRuntimeProvider` accepts a transport registry keyed by model
  provider instead of one transport: `{anthropic: {baseUrl:
'https://api.anthropic.com', apiKey: ANTHROPIC_API_KEY}, kimi: {baseUrl:
KIMI_BASE_URL, apiKey: KIMI_API_KEY}}`. `start` picks the transport by the
  synced agent's `modelProvider` and fails closed with a named error when that
  provider has no key. Handle ids, the access store id prefixes and the
  routing facade are untouched.
- The routing key `process` is accepted as an alias of `kimi` in
  `resolveRoleRuntimeKeys` (`trigger/production-handler.ts:317-351`), so a
  project config can say `runtime: {provider: process}` and route every model
  provider to the local sandbox. The `kimi` key keeps working.
- The `kimi/README`-level description in `docs/architecture/kimi-runtime.md`
  gets a section naming the provider "process runtime" and recording that the
  Anthropic transport carries no prompt-cache or streaming fields yet.

### Source tree in the sandbox

Today the whole repository reaches the sandbox as one JSON file,
`inputs/source-bundle.json`, which the model must unpack itself with `bash`.
The dogfood specification sessions spent their first minutes failing `bash`
calls against that file. The process runtime's `start` will unpack every
mounted resource whose body is `source-bundle-v1` into `repo/` in the workdir
(the same loop `MATERIALIZE_SCRIPT` runs, `production-handler.ts:214-228`),
leaving the JSON in place for provenance. The bundle limits
(`github/source-snapshot.ts:13-16`, 16 MiB decoded) bound the unpack.

### Verification on the process runtime

`resolveRoleRuntimeKeys` currently refuses to route `verification` to `kimi`
because `exactTrustedCommand` (`production-handler.ts:236-241`) bakes
container-absolute paths such as `rm -rf /workspace/repo`. The refusal stays
for the `kimi` key against Managed-shaped commands. For the local composition,
`resolveTestCommand` produces a **workdir-relative** trusted command: the same
materialize script with `root` resolved from `process.cwd()`, run as
`rm -rf repo && mkdir repo && node inputs/materialize.mjs inputs && cd repo &&
pnpm install --frozen-lockfile --ignore-scripts && <allowlisted> && node --test
'test/acceptance/*.test.mjs'`. `observeCommand` (`kimi/provider.ts:643`)
executes it under the session mutex with the secretless environment, so the
signed `trusted-test-report` chain (`trigger/verifier.ts:44`) is produced by
trusted code exactly as before. The allowlist source
(`AGENTOS_TRUSTED_TEST_COMMANDS_JSON`) and the attestation keys
(`AGENTOS_TEST_REPORT_KEYS_JSON`) are unchanged.

The verification role still starts a model session before trusted code
observes the command, because the workflow step does. On the process runtime
that session contributes nothing. Skipping it is a follow-up in the pipeline
spec; v1 accepts the spend.

The `$HOME = workdir` limitation recorded in `kimi-runtime.md` means an agent
could plant an `.npmrc` that the trusted install later reads. For a
single-operator local repository this is the operator's own machine and their
own working copy; the design records the exposure and does not claim it away.

### Artifacts on disk

`createFilesystemArtifactStorage({root})` in
`packages/adapters/src/artifacts/filesystem.ts` implements the same
`ArtifactStore` and `ArtifactAdminStore` ports as `in-memory.ts:61`, storing
bodies content-addressed under `<root>/artifacts/v1/<projectId>/...`, and must
pass `artifact-store-contract.ts`. The durable manifest store
(`createDomainArtifactManifestStore`) stays in the repository, so the run page
and the MCP quota logic see no difference.

The Artifact MCP call from the sandbox tools stays a JSON-RPC request, but the
process runtime gains an optional `artifactMcp.fetch` and the local composition
passes a function that invokes the in-process handler from
`createArtifactMcpHandler` (`artifacts/mcp.ts:584`) directly. No port, no
tunnel, no public URL. The HTTPS assertion on `AGENTOS_ARTIFACT_MCP_URL`
(`production-handler.ts:376-380`) is bypassed by the local composition, not
relaxed globally.

### Local composition

`createLocalDirectFeatureWorkflowFromEnv(env)` in
`packages/adapters/src/local-direct/composition.ts` builds the feature task
handler with:

| dependency                                                             | local-direct                                     | today                   |
| ---------------------------------------------------------------------- | ------------------------------------------------ | ----------------------- |
| repository, checkpoints                                                | as configured (Neon or memory)                   | Neon                    |
| artifacts                                                              | filesystem store under `AGENTOS_LOCAL_STATE_DIR` | R2                      |
| runtime                                                                | process runtime, transports by model provider    | Managed Agents (+ Kimi) |
| approval                                                               | local waiter                                     | Trigger waitpoint       |
| sourceSnapshot                                                         | `createLocalSourceSnapshotIngestor`              | same for local projects |
| publisher                                                              | `createLocalGitPublisher`                        | same for local projects |
| resolveTestCommand                                                     | workdir-relative trusted command                 | container-absolute      |
| verifier, publicationAuthority, handleSealer, priceUsage, budgetLimits | unchanged                                        | unchanged               |

Shared construction that `production-handler.ts:353-540` does inline (issuer
and verifier keys, handle sealer, trusted-command allowlist, budget limits) is
extracted into small exported helpers so the two compositions cannot drift.
The local composition refuses a project whose config names
`project.repository` instead of `project.localPath`, with a message that says
the GitHub path needs the Trigger executor.

Required variables for `local-direct`: `AGENTOS_EXECUTOR`,
`AGENTOS_LOCAL_STATE_DIR`, `AGENTOS_LOCAL_WORKSPACES_ROOT`, one of
`ANTHROPIC_API_KEY` or `KIMI_API_KEY`, `AGENTOS_TRUSTED_TEST_COMMANDS_JSON`,
`AGENTOS_TEST_REPORT_KEYS_JSON`, `ARTIFACT_CAPABILITY_KEYS_JSON`,
`GITHUB_PUBLICATION_KEYS_JSON` (the publication authority key the local
publisher already verifies), `AGENTOS_RUNTIME_HANDLE_KEY`,
`AGENTOS_RUNTIME_OWNERSHIP_SECRET`. Not read: `TRIGGER_*`, `CLOUDFLARE_R2_*`,
`AGENTOS_ARTIFACT_MCP_URL`, `ARTIFACT_MCP_ALLOWED_ORIGINS`, `GITHUB_APP_*`.
`.env.example` documents the split; readiness
(`apps/control-plane/src/application/setup-readiness.ts`) reports the executor
in use and which of its variables are missing.

## Scope and implementation boundary

Lives in:

- new `packages/adapters/src/local-direct/{dispatcher,approval-waiter,composition}.ts`
  and tests
- new `packages/adapters/src/artifacts/filesystem.ts` and its contract test
- `packages/core/src/ports.ts` (`RuntimeAgent.modelProvider?`)
- `packages/adapters/src/kimi/{provider,from-env,transport}.ts` (transport
  registry, `artifactMcp.fetch`, source-bundle unpack)
- `packages/adapters/src/trigger/production-handler.ts` (extract shared
  helpers; `process` alias in `resolveRoleRuntimeKeys`; fill `modelProvider`)
- `apps/control-plane/src/application/runtime.ts` (`workflowDispatchFromEnv`
  second branch), `setup-readiness.ts`, `.env.example`
- `docs/architecture/kimi-runtime.md`, `docs/architecture/durable-feature-workflow.md`
  (one section each), `docs/progress.md`

Must not touch:

- `packages/adapters/src/trigger/workflow.ts`, `outbox.ts`, `types.ts`
  (beyond the resume-branch changes already merged)
- `packages/adapters/src/trigger/production-composition.ts` role rules
- `packages/adapters/src/managed-agents/**`, `github/**`
- the approval read (`getAuthoritativeApproval`), the verifier, the
  publication authority, the checkpoint admission SQL
- any migration

## Security review

- Credentials never enter a session: the process sandbox already builds a
  `PATH`/`HOME`/`LANG` environment for every `bash` and observed command.
  Model keys live in the transport registry only.
- Approval decisions are still read from the database after wake; the waiter
  only reports "something changed".
- Publication is still the trusted local-git publisher behind the HMAC
  publication authority; the sandbox never sees the operator's working tree.
- The sandbox limits are unchanged and are the weakest part of this design.
  They were accepted for the Kimi provider on 2026-08-17 and are accepted
  here for the same single-operator reason. Do not enable `local-direct` on a
  shared host.
- Two executors cannot be active at once (boot-time check), so no run can be
  claimed twice.

## Testing

Every one of the eighteen recorded failures happened at a boundary the tests
mocked. The test plan for this design therefore has two tiers, and the first
tier alone does not count as verification.

Credential-free:

- `filesystem.test.ts` runs `artifact-store-contract.ts` against a temp dir.
- `approval-waiter.test.ts`: resolves on `wake`, resolves on poll after a
  consumed row, times out at `expiresAt`, survives `create` being called twice
  for the same key.
- `dispatcher.test.ts`: reference format, one retry on transient error, `lost`
  after a fresh instance, `startGoal` refusal, cancel aborts.
- `composition.test.ts`: refuses a GitHub project, refuses both executors,
  reports missing variables by name.
- Process runtime: transport chosen by `modelProvider`, missing key fails
  closed, source bundle unpacked into `repo/`, workdir-relative trusted
  command observed with exit code.
- The existing `workflow.test.ts` fixture is re-run with the local waiter in
  place of the inline one to prove the workflow cannot tell the difference.

Live gate (opt-in, `AGENTOS_LIVE_TESTS=1`, spends money):

- `pnpm --filter @agentos/adapters smoke:local-direct`: initializes a fixture
  repository under a temp workspaces root, applies a minimal config, runs one
  feature through `createLocalDirectFeatureWorkflowFromEnv` with a real model
  key, approves the spec, and asserts an `agentos/<run>` branch exists with a
  signed trusted-test-report. This is the check that would have caught every
  boundary failure in the evaluation.
- The exit gate above, driven from the UI on this repository, three times.

## Out of scope / follow-ups

- Two-step pipeline and skipping the verification model session (next spec).
- Structured output via tool calls for the Managed path.
- `agentos worker` as a separate process if Next reloads interrupt sessions.
- Goal runs on the local executor.
- Prompt caching in the Anthropic transport (cost, not correctness).
- Embedded Postgres for a fully credential-free local stack.
