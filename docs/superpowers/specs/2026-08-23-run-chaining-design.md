# Run Chaining: A Second Feature That Builds On The First

Status: Approved design
Date: 2026-08-23
Approach: let a run declare a *base run* instead of a bare SHA; the control
plane derives the source SHA from that run's own publication record, so the
chain is server-verified rather than caller-asserted

## Follow-up decision (2026-08-23) — overrides Slice 1's mutual exclusion

Reading the dispatch path changed the shape. `task-handler.ts:120-131`
re-asserts, at trigger time, that the run's config snapshot and its
`provenance.repositorySha` agree, and resolves source ingestion from that
same field. Making `repositorySha` absent for chained runs would mean
touching that check, the goal input validators that mirror it
(`goal-workflow.ts:201-213`), and the createRun provenance search — four
places, each one a fail-closed guard worth keeping exactly as written.

So: **`provenance.repositorySha` stays required and keeps its meaning — the
SHA of the applied configuration revision.** A chained run carries it *and*
`baseRunId`. The chain does not replace provenance; it adds a separate,
server-derived source override that redirects two things and nothing else:

- what SHA source ingestion resolves (`chain.baseCommitSha`, not
  `provenance.repositorySha`), and
- what the publication manifest names as `expectedBase`.

Every existing provenance assertion runs unchanged. The `chain_configuration_changed`
check becomes trivially true by construction — both runs name the same
revision because both carry that revision's SHA — and stays as an explicit
assertion rather than an implicit one.

## Context

Passerine executes one feature per run. Run N ingests the repository at a
SHA, produces a change set, and publishes a draft PR (or an
`agentos/run-<id>-<digest>` branch in a local experiment). Run N+1 ingests
the repository again — at a SHA the caller supplies — and never sees run N's
work unless the operator has merged it first.

That is the throughput ceiling for anything larger than one feature. A
five-feature body of work costs five operator merges *interleaved with* the
runs, each one blocking the next. It also makes the goal loop's three
attempts the only form of multi-run work the system can express, and those
are retries of one feature, not successive features.

Three facts decide the design:

1. **Run creation binds the source SHA to an applied configuration
   revision.** `createRun` searches the project's revisions for one whose
   five provenance digests *and* `repositorySha` equal the request
   (`apps/control-plane/src/application/control-plane-service.ts:1130-1150`),
   and 409s otherwise. A caller cannot start a run at an arbitrary SHA
   today, and that is deliberate: what the agent sees is exactly the repo
   state the operator applied configuration against.
2. **Head resolution only knows the default branch.**
   `repositoryHeadResolverFromEnv().resolve()` runs `rev-parse
   <config.project.defaultBranch>` locally, and the GitHub path resolves the
   selected repository's default branch
   (`apps/control-plane/src/application/runtime.ts:160-215`). So "apply
   configuration again to pick up run N's branch" is not expressible.
3. **The publication layer is already general.** The manifest carries
   `expectedBase: { branch, sha }` (`packages/core/src/publication.ts:127`),
   and both publishers honor it; only
   `packages/adapters/src/trigger/production-handler.ts:590` narrows it to
   `config.project.defaultBranch` + the run's source SHA. Every successful
   publication records `branch` and `commitSha`
   (`packages/adapters/src/trigger/schemas.ts:100-120`) — required for local,
   optional for draft PRs.

The invariant worth keeping is *not* "runs start from the default branch".
It is **"a run's source state is one the operator approved, and the system
can prove where it came from."** Chaining preserves that as long as the base
is a commit this system itself published, under a configuration revision the
operator applied.

## Goal

An operator can start feature N+1 on top of feature N's published work
without merging first, and the resulting branch stack merges as one unit or
as a sequence, at the operator's choice. The chain is verified by the
control plane from its own publication records — never from a SHA the caller
asserts.

## Non-goals

- Do not automate merging, rebasing onto a moved default branch, or conflict
  resolution. A chain that goes stale fails closed and the operator decides.
- Do not weaken the provenance check into "any 40-hex string". The
  `configuration revision ↔ repository state` binding stays; chaining adds
  exactly one more admissible source, with a server-side derivation.
- Do not add a backlog, scheduler, or automatic "next feature" dispatch.
  Chaining is the mechanism those need; they are separate work.
- Do not change the goal workflow. Goal children stay independent attempts
  from the same base; chaining them is a later decision, not this slice.
- Do not touch the publication HMAC, the trusted-test-report chain, or the
  frozen acceptance-test seal.
- Do not introduce a long-lived integration branch per project. That is the
  obvious alternative and it is deferred deliberately — see Alternatives.

## Scope and implementation boundary

Three seams, in this order:

1. **Run creation** (`control-plane-service.ts` `createRun`, `contracts.ts`
   `createRunSchema`): accept `baseRunId`, derive the source SHA, and record
   the chain edge on the run input.
2. **Source ingestion** (`production-handler.ts` `loadSource` and the GitHub
   / local source snapshot adapters): ingest at the derived SHA — already
   SHA-bound, so this is a matter of the SHA reaching it, not new mechanism.
3. **Publication base** (`production-handler.ts:590`): `expectedBase` becomes
   the base run's published branch and commit rather than
   `defaultBranch` + source SHA.

Must not touch: `packages/core/src/dod.ts`, `acceptance-tests.ts`,
`verification-policy.ts`, `attestation.ts`, publication HMAC, session
leases, Trigger task IDs, budget admission SQL.

## Concepts

**A chain edge is a run, not a ref.** The request names
`baseRunId`; the server reads that run, requires it `succeeded` in the same
project, reads its recorded publication `branch` + `commitSha`, and uses
that commit as the new run's source SHA. The caller never states the SHA for
a chained run — `repositorySha` is rejected as mutually exclusive with
`baseRunId`, so there is no path where a caller's SHA is trusted.

**Provenance for a chained run.** The run still needs one applied
configuration revision, matched on the five digests as today. The
`repositorySha` equality check is replaced, for chained runs only, by:
the base run's own config snapshot must name the *same* configuration
revision the new run resolves. That is stronger than a SHA match — it says
the whole chain executed under one applied configuration, which is the
property the SHA check was standing in for. A configuration applied between
run N and run N+1 breaks the chain and the operator starts a fresh run from
the new head.

**The chain is a line, not a tree.** A run may be the base of at most one
non-terminal chained run. Two features started from the same base would
publish two branches from one commit that neither knows about the other, and
the second would fail its own publication policy on overlapping files —
better to reject it at creation with a clear error than to spend a run
discovering it. `chained_base_taken` (409).

**Depth is bounded.** `AgentOsConfig.chains.maxDepth`, 1–10, default 3.
A chain deeper than the bound is a request to run a project, not a feature,
and should fail loudly until the backlog work that owns that concern exists.

**Staleness fails closed.** The existing publisher check
(`publisher.ts:493-511`: `baseRef?.sha === expectedBase.sha`, else an
ancestry check) already refuses to publish onto a base that moved. A chained
run inherits it unchanged: if the operator merged or deleted the base branch
mid-chain, publication fails with the existing stale-base error and the run
ends without touching the repository.

## Slice 1 — Chain edges at run creation

`createRunSchema` gains `baseRunId: id.optional()`, with a refinement
rejecting a request that carries both `baseRunId` and `repositorySha`, and
one that carries neither.

`createRun` resolves a chained request:

- base run exists, `projectId` matches, `status === 'succeeded'` — else 422
  `base_run_unavailable`;
- base run's output carries a publication `branch` and `commitSha` — else 422
  `base_run_unpublished` (a draft-PR publication whose optional `commitSha`
  is absent is *unchainable*, and says so rather than guessing);
- base run's single config snapshot names the same revision the new run
  resolved — else 409 `chain_configuration_changed`;
- no other non-terminal run in the project already names this base — else 409
  `chained_base_taken`;
- chain depth (walk `baseRunId` back through run inputs) < `chains.maxDepth`
  — else 422 `chain_too_deep`.

The resolved values land on the immutable run input as
`chain: { baseRunId, baseBranch, baseCommitSha }`, next to the existing
`provenance` block, so every downstream reader sees one authoritative record
and the durable-input validators can check it the same way they check
provenance today.

## Slice 2 — Ingest and publish against the chain

Source ingestion takes the SHA from `chain.baseCommitSha` when present. The
GitHub reader already fetches an arbitrary SHA-bound tree; the local reader
already `rev-parse`s a caller-supplied SHA. The reachability question — is
this SHA on a ref the reader may see — is answered by the fact that the
system published it under this project's binding, and is re-asserted by the
existing SHA-bundle digest check.

`expectedBase` becomes `{ branch: chain.baseBranch, sha:
chain.baseCommitSha }` for a chained run, and keeps
`{ defaultBranch, source.repositorySha }` otherwise. The new run publishes
its own `agentos/run-<id>-<digest>` branch off the base branch's tip, so the
operator sees N branches, each containing its predecessors' commits, and can
merge the last one to take the whole stack.

For draft PRs, the new PR's base is the base run's branch, not the default
branch, so the diff GitHub shows is the new feature alone.

## Slice 3 — Operator surface

- Run page: a "Builds on" line linking the base run, and on the base run,
  "Continued by". Both read the immutable input, no new persistence.
- Run page outcome block: for a chained run, the merge instruction names the
  whole stack ("merging this branch takes runs 1–3").
- `POST /api/features` accepts `baseRunId`; the CLI gains
  `feature start --base-run <id>`.
- The run list shows a chain marker so a stack is legible at a glance.

Deliberately omitted: a "start a follow-up" button on the run page. It is
the obvious affordance and it belongs with the backlog work, where the next
feature's description comes from somewhere other than the operator typing it
again.

## Alternatives considered

**A long-lived integration branch per project.** Every run bases on
`agentos/integration`, and publication fast-forwards it. Simpler chain
bookkeeping, one branch to merge, and no depth bound needed. Rejected for
now because it makes the branch a mutable shared resource that two runs can
race for, which reintroduces exactly the global-singleton class of bug the
multi-project work spent five phases removing — and because a failed run
would leave the integration branch carrying work no PR describes. Worth
revisiting once per-project concurrency > 1 is real.

**Chaining by re-applying configuration at the new head.** Reuses all
existing machinery and needs no new run input. Rejected because head
resolution is default-branch-only in both modes, so it would require the
operator to merge first — which is the problem.

## Verification

Credential-free, through the existing contract harnesses:

- Chain creation: base not succeeded, base in another project, base
  unpublished, base already chained, configuration changed between runs,
  depth bound — each its own case with its own error code.
- `repositorySha` + `baseRunId` together is a 422; neither is a 422.
- A chained run's ingestion request carries the base commit SHA, and its
  manifest's `expectedBase` names the base branch — asserted at the
  production-handler seam, where both are constructed.
- Local end-to-end, against a local experiment repository: run A publishes
  `agentos/run-A-…`; run B chained on A starts from A's commit, sees A's
  files in its source bundle, and publishes `agentos/run-B-…` containing
  both commits. This is the one that proves the feature, and it needs no
  GitHub App.
- Stale base: delete/move the base branch between runs and confirm the
  existing stale-base failure fires without a partial write.

## Out of scope

Automatic follow-up dispatch, backlog decomposition, rebasing a stale chain,
merging, cross-project chains, chaining goal children, and any change to
what a single run is allowed to do.
