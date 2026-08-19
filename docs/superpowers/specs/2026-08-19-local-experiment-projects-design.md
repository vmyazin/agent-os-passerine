# Local Experiment Projects

Status: draft for review
Date: 2026-08-19
Approach: local adapters behind the existing source/publication seams

## Goal

Let the operator create and iterate on experiment projects entirely against a
local git repository — no GitHub Apps, no remote repository — while running
the same feature pipeline (specification → planning → implementation → review
→ sealed verification). A successful run ends as a commit on a new local
branch instead of a draft pull request. Publishing later is the operator
running `git push` themselves.

Explicitly in scope: local source ingestion, local branch publication, wizard
support for creating and selecting local repositories, config and readiness
changes. Explicitly out of scope: fully local execution (sessions still run
in the Managed Agents cloud sandbox and artifacts still live in R2), any
automatic push or GitHub sync, multi-operator concerns.

## Concepts

A project is one of two kinds, decided by its configuration:

- **GitHub project** — `project.repository` is a `https://github.com/...`
  URL. Current behavior, unchanged.
- **Local experiment** — `project.localPath` names a directory that is a git
  repository on the machine that runs the control plane and the Trigger
  worker. `repository` and `localPath` are mutually exclusive; exactly one
  must be present for the feature pipeline to dispatch.

## Trust boundary: the workspaces root

New environment variable `AGENTOS_LOCAL_WORKSPACES_ROOT` — an absolute path.
Every `project.localPath` must resolve (after `realpath`, following no
symlinks out) to a directory strictly inside this root. The control plane and
worker refuse any path outside it, the same fail-closed posture as protected
paths. When the variable is absent, local experiment projects are rejected at
dispatch and the wizard hides the local option.

Rules:

- `localPath` must be absolute, contain no `..` segments, and its realpath
  must start with the workspaces root's realpath plus a separator.
- The directory must contain a `.git` directory (a working repository, not a
  bare one).
- All git operations run with `git -C <path>` and plumbing commands only
  (`rev-parse`, `ls-tree`, `cat-file`, `hash-object -w`, `mktree`,
  `commit-tree`, `update-ref`). Plumbing never runs hooks and never touches
  the operator's working tree or checked-out branch.

## Local source ingestion

`createLocalSourceSnapshotIngestor` implements the existing
`TrustedSourceSnapshotIngestor` contract (`ensure(runId)`):

1. Resolve the run's binding exactly as the GitHub ingestor does (config
   snapshot, pinned `repositorySha`).
2. Verify `git -C <localPath> rev-parse <repositorySha>^{commit}` succeeds
   and that the SHA equals the pinned value.
3. Enumerate the commit's tree with `git ls-tree -r <sha>`; reject entries
   that are not blobs with mode `100644`/`100755`, reject paths that fail the
   existing `safePath` rules, reject binary content (NUL byte scan), and
   enforce the existing `MAX_SOURCE_BUNDLE_BYTES` limit.
4. Build the identical `source-bundle-v1` body the GitHub ingestor builds
   (`files[{path, mode, content}]`, `repositorySha`, `treeSha`, plus a
   repository identity — see below) and store it via the same idempotent
   artifact write (`stepId: 'source'`, `artifactId: 'bundle'`).

Repository identity for local projects is an explicit variant, not a
sentinel value: `{ kind: 'local', owner: 'local', name: <basename of
localPath> }` with no `installationId` or `repositoryId` fields. The
source-bundle schema and the publication manifest schema in core each become
a discriminated union of the existing GitHub identity (which keeps its
positive `installationId`/`repositoryId` requirements, unchanged) and this
local identity. The GitHub publisher and reader accept only the GitHub
variant, so a local manifest is structurally incapable of reaching GitHub,
and no GitHub client is ever constructed for a local project.

Everything downstream (file mounts, the materialize script, verification) is
already bundle-driven and needs no change.

## Local publication

`createLocalGitPublisher` implements the same `publish(input)` contract as
the trusted GitHub publisher:

1. Parse the publication manifest and validate the HMAC authorization with
   the existing `validatePublicationAuthorization`, with audience
   `local-git-publisher` (the authority stamps this audience for local
   projects; a GitHub authorization can never be replayed against the local
   publisher or vice versa).
2. Re-evaluate `evaluatePublicationPolicy` over the change set (protected
   paths, size, mode, binary and symlink rules) — same defense in depth as
   the GitHub publisher.
3. Verify `expectedBase.sha` still equals `git rev-parse <defaultBranch>`;
   reject with the existing "base changed" error otherwise.
4. Materialize the change set with plumbing: read the base tree, apply
   add/modify/delete entries via `hash-object -w` and `mktree`, create the
   commit with `commit-tree` (author/committer "Agent OS Publisher"), and
   create branch `agentos/<runId>-<manifestDigest[0..8]>` with
   `update-ref refs/heads/<branch>` guarded against overwriting an existing
   ref.
5. Persist the same publication record phases (`branch_created` →
   `committed` → `succeeded`) through the existing publication store for
   idempotent replay.
6. Return `{ status: 'succeeded', local: true, branch, commitSha,
   repositoryUrl: 'file://<localPath>' }`.

The workflow's publication result schema becomes a discriminated union:
the existing draft-PR shape, or the local shape above (`local: true`
replacing `draft: true`, `repositoryUrl` as a `file:` URL instead of
`pullRequestUrl`). The run output stores whichever variant ran; the run page
shows "Local branch `<branch>`" for local results.

## Composition and dispatch

`createProductionFeatureWorkflowFromEnv` selects per snapshot:

- `config.project.localPath` set → local ingestor + local publisher +
  local head resolution. GitHub reader/publisher configuration is not
  required and not constructed.
- `config.project.repository` set → current GitHub path, unchanged.
- Both or neither set → dispatch is rejected with a configuration error.

The control-plane dispatch outbox picks the matching source ingestor the
same way. The publication authority stamps the audience by project kind.

## Config schema

`project.localPath`: optional string, absolute path, max 1,024 characters.
Core validation enforces mutual exclusion with `repository`. The canonical
config, digests, and provenance mechanics are unchanged — `repositorySha`
now pins a local commit for experiment projects, with identical semantics.

## Wizard changes

Step 2 gains a project-type choice:

- **GitHub project** — current template and flow.
- **Local experiment** — template swaps `repository:` for `localPath:`;
  step 1's GitHub Apps group becomes "required for GitHub projects" and does
  not block local setup; a new action "Create local repository" calls
  `POST /api/setup/local-repository` with a directory name, which
  (inside the workspaces root only) runs `git init`, writes a seed
  `package.json` (`"test": "node --test"`), a passing smoke test, commits,
  and returns the path and HEAD SHA; step 3 resolves the head with
  `git rev-parse` through a local branch of the existing
  `/api/setup/repository-head` endpoint instead of the GitHub reader.

Step 4 is unchanged.

## Readiness changes

The GitHub Apps group is re-labeled "GitHub Apps (GitHub projects)". A new
group "Local workspaces (experiments)" reports
`AGENTOS_LOCAL_WORKSPACES_ROOT`. Overall readiness is satisfied for local
work when every non-GitHub group is green plus the local group; the wizard
computes "ready for the selected project type" rather than one global
boolean.

## Security review

- Path containment is checked in every entry point that receives a path
  (config validation, ingestor, publisher, setup routes), not once.
- Plumbing-only git: no hooks execute, no checkout, no working-tree writes;
  the operator's uncommitted work is never touched.
- The publication authorization audience split prevents cross-mode replay.
- Protected paths, binary, symlink, and size policy run identically in the
  verifier and the local publisher.
- The local repository identity is a distinct schema variant with no
  installation or repository IDs; the GitHub publisher and reader accept
  only the GitHub variant, so a local manifest can never reach GitHub.
- Experiment code still transits Anthropic's sandbox and R2 — the wizard's
  local mode copy states this plainly.

## Testing

- Local ingestor: temp git repos (fixture helper) — bundle equality with a
  known tree, SHA mismatch rejection, binary rejection, path escape
  rejection, symlink rejection, size limit.
- Local publisher: authorization validation (wrong audience rejected), base
  drift rejection, protected path rejection, branch creation without
  touching the working tree (assert `git status --porcelain` unchanged),
  idempotent replay from the publication record.
- Containment: escape attempts via `..`, absolute paths outside the root,
  and symlinked directories.
- Composition: local config selects local adapters; both/neither repository
  fields rejected.
- Setup routes: create-repository containment and seeding; head resolution
  for a local project.
- Existing GitHub-path tests must pass unchanged.

## Out of scope / future

- Fully local execution (Kimi runtime routing for experiments).
- Promoting a local experiment to a GitHub project (config edit does it
  manually; a guided "publish project" flow is future work).
- Goal pipelines for local projects ship only if they fall out for free;
  otherwise a follow-up.
