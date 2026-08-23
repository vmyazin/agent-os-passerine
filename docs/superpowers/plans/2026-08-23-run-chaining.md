# Run Chaining Implementation Plan

**Goal:** feature N+1 starts from feature N's published commit without an
operator merge, with the base SHA derived by the control plane from its own
publication record.

**Spec:** `docs/superpowers/specs/2026-08-23-run-chaining-design.md`
(including the 2026-08-23 follow-up decision: `provenance.repositorySha`
keeps its meaning; the chain is a separate, server-derived source override).

**Architecture:** the chain edge lives on the immutable run input as
`chain: { baseRunId, baseBranch, baseCommitSha }`. It redirects exactly two
things — the SHA source ingestion resolves, and the publication manifest's
`expectedBase`. Every existing provenance assertion runs unchanged.

## Global constraints

- Do not modify `packages/core/src/dod.ts`, `acceptance-tests.ts`,
  `verification-policy.ts`, `attestation.ts`, publication HMAC, session lease
  keys, Trigger task IDs, or budget admission SQL.
- Do not weaken any existing provenance check. Chained runs must satisfy all
  of them as written.
- No new migration. Chain state lives in the run input; the "base already
  taken" check pages the project's non-terminal runs, which are few by
  construction (per-project concurrency is 1).
- File comment at the top of each new/changed TS file.

## File map

| Path | Role |
| --- | --- |
| `packages/adapters/src/trigger/types.ts` | `FeatureWorkflowResult` gains published branch/commit |
| `packages/adapters/src/trigger/workflow.ts:1748-1760` | Terminal result carries them |
| `packages/adapters/src/trigger/schemas.ts:24-41` | `chain` on `featureWorkflowInputSchema` |
| `packages/core/src/config.ts:137` (near goals) | `chains.maxDepth`, optional, default 3 |
| `apps/control-plane/src/http/contracts.ts:14-26` | `baseRunId` on `createRunSchema` |
| `apps/control-plane/src/application/control-plane-service.ts:460-480,1043,1106-1152` | `inputForRun` chain block; chain resolution in `createRun` |
| `packages/adapters/src/trigger/task-handler.ts:132-160` | Ingest and workflow input use the chain SHA |
| `packages/adapters/src/trigger/production-handler.ts:584-596` | `expectedBase` from the chain |
| `apps/control-plane/src/application/run-page-model.ts` | "Builds on" / "Continued by" |
| `apps/cli/src/**` | `feature start --base-run` |
| `docs/architecture/durable-feature-workflow.md` | Execution path + chaining section |

## Do not modify

`packages/core/src/dod.ts`, `acceptance-tests.ts`, `verification-policy.ts`,
`packages/adapters/src/github/publisher.ts`,
`packages/adapters/src/local-git/publisher.ts`, `FEATURE_WORKFLOW_TASK_ID`,
`GOAL_WORKFLOW_TASK_ID`, `agentos/agent-os.yaml`.

---

### Task 1: Record the published commit on the run outcome

The chain base SHA has to come from somewhere the control plane can read.
Today the terminal output carries `localBranch`/`localRepositoryUrl` or
`draftPullRequestUrl` and drops `publication.commitSha` on the floor
(`workflow.ts:1748-1760`), even though the publisher returned it.

- [ ] `FeatureWorkflowResult` gains `publishedBranch?` and
      `publishedCommitSha?`; the terminal write includes them for both
      publication shapes (a draft PR whose optional `commitSha` is absent
      simply omits it).
- [ ] Test: a local publication's outcome carries branch + commit; a draft
      publication carries them when the publisher reported them and omits
      them when it did not.
- [ ] Verify: `pnpm --filter @agentos/adapters test`

### Task 2: Chain edges at run creation

- [ ] `chains: { maxDepth }` on the config schema — optional, default 3,
      range 1–10, so existing applied revisions keep parsing.
- [ ] `createRunSchema` gains `baseRunId: id.optional()`. `repositorySha`
      stays required (see the follow-up decision).
- [ ] `inputForRun` writes `chain: { baseRunId, baseBranch, baseCommitSha }`
      when the request is chained.
- [ ] `createRun` resolves the base, in this order, each with its own code:
      `base_run_unavailable` (422: missing, other project, not `succeeded`),
      `base_run_unpublished` (422: outcome has no branch or commit),
      `chain_configuration_changed` (409: base's config snapshot names a
      different revision), `chained_base_taken` (409: another non-terminal
      run in the project already names this base), `chain_too_deep` (422).
- [ ] Depth walk and the taken-check page through runs with the existing
      bounded pagination style; no unbounded fan-out.
- [ ] Tests: one case per error code, plus a happy path asserting the run
      input's chain block.
- [ ] Verify: `pnpm --filter @agentos/control-plane test`

### Task 3: Ingest from the chain base

- [ ] `featureWorkflowInputSchema` gains an optional `chain` block.
- [ ] `task-handler.ts` resolves the source snapshot at
      `chain?.baseCommitSha ?? provenance.repositorySha` and sets
      `source.repositorySha` to the same value; the snapshot/provenance
      assertions at `:120-131` stay exactly as they are.
- [ ] Test: a chained run's ingestion request carries the base commit, and
      an unchained run is unchanged.
- [ ] Verify: `pnpm --filter @agentos/adapters test`

### Task 4: Publish onto the chain base

- [ ] `expectedBase` becomes `{ branch: chain.baseBranch, sha:
      chain.baseCommitSha }` for a chained run, keeping
      `{ config.project.defaultBranch, workflow.source.repositorySha }`
      otherwise.
- [ ] Test at the production-handler seam: the manifest names the base
      branch, and the unchained manifest is unchanged.
- [ ] Verify: `pnpm --filter @agentos/adapters test`

### Task 5: Operator surface

- [ ] Run page: "Builds on <run>" and, on the base, "Continued by <run>";
      the outcome block for a chained run says merging its branch takes the
      whole stack.
- [ ] `POST /api/features` passes `baseRunId` through; CLI gains
      `feature start --base-run <id>`.
- [ ] Tests: run-page model shows both edges; the CLI parses the flag.
- [ ] Verify: `pnpm turbo run typecheck lint test`

### Task 6: End-to-end and docs

- [ ] Local experiment end-to-end: run A publishes `agentos/run-A-…`; run B
      chained on A ingests A's commit, sees A's files in its bundle, and
      publishes a branch containing both commits. This is the proof, and it
      needs no GitHub App.
- [ ] Stale base: move or delete the base branch between runs; confirm the
      existing stale-base failure fires with no partial write.
- [ ] Update `docs/architecture/durable-feature-workflow.md` and
      `docs/progress.md`.
