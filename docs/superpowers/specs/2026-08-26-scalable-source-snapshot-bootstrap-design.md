# Scalable Source Snapshot Bootstrap

Status: Approved design

## Context

Agent OS's first self-hosted feature run exposed a source-ingestion blocker before
any model execution began. Passerine's pinned source tree contains 678 tracked
files and approximately 7 MiB of decoded content. Both source-snapshot adapters
currently enforce a 1 MiB aggregate-content limit and a 1 MiB serialized-bundle
limit, so the repository cannot be dispatched even though every individual file
fits the existing safety boundary.

The local adapter also starts one `git cat-file blob` process per tracked file.
In the Passerine trial this spent roughly 90 seconds reading a tree that Git can
stream in one bounded batch. When ingestion then failed, the durable source
effect remained `started`; reconciliation counted the exception but did not
persist a failure reason. The run therefore appeared merely stuck in the control
plane.

This is a bootstrap change: make ordinary repositories such as Passerine
ingestible, bounded, fast, and diagnosable so the already-created "Start Work"
feature run can proceed through Agent OS itself.

## Goals

- Ingest pinned text-only source trees containing at most 5,000 files, at most
  1 MiB per file, and at most 16 MiB of decoded file content.
- Preserve one canonical `source-bundle-v1` artifact and all existing source
  identity, path, mode, binary, and idempotency checks.
- Read all local Git blobs through one bounded `git cat-file --batch` process
  rather than one process per file.
- Apply the aggregate and serialized-bundle limits consistently to local and
  GitHub source adapters.
- Persist a bounded, sanitized source-ingestion failure on the claimed durable
  effect so the existing run diagnostics can explain why dispatch stopped.
- Retry a failed or expired source-ingestion effect safely without starting the
  workflow until a source artifact has completed successfully.
- Unblock and resume the existing Agent OS self-test without spending model
  tokens before source ingestion succeeds.

## Non-goals

- Chunking source across multiple artifacts or defining a chunk manifest.
- Supporting repositories whose decoded text exceeds 16 MiB, files larger than
  1 MiB, more than 5,000 files, binary files, symlinks, submodules, Git LFS
  hydration, sparse checkouts, or nested repositories.
- Changing `source-bundle-v1`, artifact storage, R2 transport, Managed Agents
  mounts, prompts, sandbox materialization, or provider upload behavior.
- Adding ignore patterns, language-aware filtering, compression, incremental
  snapshots, or deduplication across runs.
- Changing reconciliation policy, run state transitions, approval behavior, or
  the control-plane UI.
- Implementing the user-facing "Setup" to "Start Work" copy change directly;
  that remains the payload for the Agent OS run this bootstrap change enables.
- Changing project import, repository trust, source identity, publication
  authority, or branch selection.

## Scope and implementation boundary

The local batch reader and its command validation live in
`packages/adapters/src/local-git/git.ts`. Local snapshot assembly remains inside
`createLocalSourceSnapshotIngestor` in
`packages/adapters/src/local-git/source-snapshot.ts`. The GitHub adapter keeps
its existing API read path in
`packages/adapters/src/github/source-snapshot.ts`; only the shared resource
policy changes there.

Durable failure recording is limited to the source-ingestion portion of
`requestStart` in `packages/adapters/src/trigger/outbox.ts`. Tests belong beside
those three surfaces:

- `packages/adapters/src/local-git/source-snapshot.test.ts`
- `packages/adapters/src/github/source-snapshot.test.ts`
- `packages/adapters/src/trigger/outbox.test.ts`

Do not modify artifact-store implementations, Managed Agents or Trigger task
payloads, core workflow state machines, application reconciliation, HTTP
routes, database schemas, UI components, source-bundle consumers, project
import, publication, or user-facing copy.

## Approved resource policy

The existing hard safety limits remain authoritative except where the first
self-hosted run proved the aggregate value too small:

- Maximum tracked files: 5,000, unchanged.
- Maximum decoded bytes in one file: 1 MiB, unchanged.
- Maximum aggregate decoded file bytes: 16 MiB.
- Maximum canonical serialized bundle bytes: 24 MiB.

The bundle ceiling is deliberately distinct from the content ceiling. JSON
escaping and repository/file metadata add bytes after decoded content is
validated, and valid source must not fail merely because its canonical envelope
is larger. The 8 MiB envelope allowance is bounded rather than percentage-based
so the final artifact has an absolute resource ceiling.

Both local and GitHub ingestors enforce the same four limits. Limit errors retain
the existing stable messages so callers and tests do not need provider-specific
handling.

## Local Git batch design

The local adapter first performs its existing commit, tree, entry-count, path,
type, mode, and duplicate-path validation. It sorts validated blob entries by
path exactly as it does today, then passes their object IDs to one purpose-built
batch-read helper.

The helper starts `git cat-file --batch` through the existing safe Git execution
boundary. It writes only already-validated full object IDs, one per line, to the
child's standard input. It parses standard output as bytes rather than lines:

1. Read the header for the requested object.
2. Require the reported object ID to match the request, type to be `blob`, and
   size to be a non-negative bounded integer.
3. Read exactly the reported number of bytes as the blob body.
4. Require the single protocol delimiter after the body.
5. Repeat in request order and reject missing, extra, malformed, or trailing
   protocol data.

The process output remains subject to an absolute cap large enough for the
24 MiB bundle policy plus protocol headers and delimiters; it must never become
an unbounded buffer. The helper returns byte-exact bodies. Snapshot assembly
performs strict UTF-8 decoding, rejects NUL-containing content, enforces the
per-file and running 16 MiB limits, and then builds the same sorted canonical
bundle.

Batch support is narrow: it does not create a generic shell or arbitrary Git
stdin API. The subcommand, flag, object-ID grammar, output cap, and protocol
parser are fixed by the adapter so repository content cannot influence command
selection or arguments.

## GitHub adapter behavior

The GitHub ingestor retains its current authenticated, read-only, pinned-commit
flow and per-blob API reads. It changes only the aggregate decoded-content and
serialized-bundle ceilings to 16 MiB and 24 MiB respectively. Existing tree,
path, mode, binary, stale-SHA, and individual-file safeguards remain unchanged.

No batching claim is made for GitHub API reads in this slice. The urgent
performance defect is the local per-file process spawn; changing remote API
fetch strategy would mix a separate rate-limit and transport concern into the
bootstrap fix.

## Durable failure behavior

`requestStart` continues to claim and mark the source-snapshot effect before
calling the ingestor. The ingestion call and source-effect completion are
handled as one guarded operation:

- On success, attach the artifact key and complete the source effect exactly as
  today, then continue to Trigger dispatch.
- On failure, mark that same claimed source effect failed with a sanitized,
  bounded diagnostic and rethrow the exception.
- Do not claim or start the Trigger workflow effect after a source failure.
- On a later reconciliation pass, the existing durable-claim rules may reclaim
  a failed or expired source effect. Successful retry completes the source
  effect once and proceeds to dispatch once.

The stored diagnostic may describe the stable ingestion error category and
message, but must not include stack traces, environment values, credentials,
process command lines, repository file contents, or unbounded provider/Git
output. Existing run diagnostics already read durable-effect errors, so no new
UI state or component is required.

## Data flow

1. Reconciliation asks the durable outbox to start the pending run.
2. The outbox owns the `source:<runId>` effect and marks it started.
3. The selected source adapter validates the pinned tree and produces one
   canonical bundle within the approved limits.
4. The artifact metadata is attached to and completes the source effect.
5. Only then does the outbox claim the workflow-start effect and dispatch the
   Trigger feature task.
6. If step 3 or 4 fails, the source effect records the bounded failure and the
   exception returns to reconciliation; steps 4 and 5 do not partially proceed.

## Alternatives considered

### Raise the limits only

This would let Passerine fit, but local ingestion would still start hundreds of
Git processes and failures would still appear as stuck runs. It treats the
symptom without making the first real workflow operationally trustworthy.

### Bounded batch reader plus recorded failure — selected

This preserves the existing single-artifact protocol while addressing all
three observed blockers: capacity, process-spawn cost, and silent failure. It is
the smallest design that makes ordinary repository ingestion usable.

### Chunked snapshot manifest

Chunking is the appropriate future direction for large monorepos, but it changes
artifact identity, runtime mounts, materialization, retry semantics, and likely
provider transport. Those changes are not required to run Passerine and would
turn a bootstrap fix into a new distributed snapshot protocol.

## Test-first verification

Production changes follow observed failing tests:

1. Local snapshot tests prove a repository above the former 1 MiB aggregate
   ceiling and below 16 MiB succeeds and round-trips byte-exact text through a
   single batch read.
2. Local tests prove malformed batch headers, mismatched object IDs/types,
   truncated bodies, invalid delimiters, extra output, invalid UTF-8, and
   over-limit content fail closed. Existing binary, symlink/submodule, path,
   mode, duplicate, pinned-SHA, and idempotency tests remain green.
3. GitHub snapshot tests prove aggregate content above 1 MiB and at or below
   16 MiB succeeds, content above 16 MiB fails, the 1 MiB individual-file limit
   remains unchanged, and oversized serialized output fails at 24 MiB.
4. Outbox tests prove an ingestion exception records a failed source effect with
   a bounded sanitized error, does not start Trigger, and can be reclaimed by a
   subsequent successful request without duplicate dispatch.
5. Adapter unit tests, repository tests, typecheck, lint, and build pass.
6. The live self-test is reconciled again. Source ingestion must complete in a
   practical bounded interval, the run must reach its specification approval
   gate, and no model execution may begin before the source artifact succeeds.

## Acceptance criteria

- Passerine's approximately 7 MiB pinned source tree ingests successfully under
  the 16 MiB content and 24 MiB bundle limits.
- Local ingestion performs one batch blob-read process rather than one process
  per file.
- Existing file-count, individual-file, safe-path, supported-mode, text-only,
  pinned-identity, and canonical-order guarantees remain enforced.
- Local and GitHub adapters share the same explicit resource policy.
- A source-ingestion exception leaves a durable failed effect with a safe,
  useful diagnostic and never starts the model workflow.
- A safe retry can complete ingestion and dispatch exactly once.
- The existing "Start Work" Agent OS run advances to its human specification
  approval gate after the bootstrap fix is active.
- No chunking protocol, provider transport, UI, project-import, publication, or
  user-facing copy changes are included.

## Follow-up boundary

Chunked snapshots should be considered only when a real repository exceeds the
approved bounded whole-repository policy. That work requires its own design for
manifest identity, chunk ordering, runtime materialization, partial retry,
provider limits, and migration from `source-bundle-v1`; this spec intentionally
does not pre-decide those details.
