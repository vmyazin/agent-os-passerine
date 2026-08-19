# Local Experiment Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the feature pipeline against a local git repository — local source ingestion and local branch publication — so experiment projects never touch GitHub.

**Architecture:** Two new adapters (`LocalSourceSnapshotIngestor`, `LocalGitPublisher`) behind the existing source/publication seams, selected per project by `project.localPath`; a workspaces-root trust boundary; plumbing-only git via `child_process`; a `{kind:'local'}` repository identity variant in the bundle and manifest schemas; wizard and readiness support.

**Tech Stack:** TypeScript, Zod 4, node:child_process (git plumbing), Next.js 16 route handlers, Vitest.

**Spec:** docs/superpowers/specs/2026-08-19-local-experiment-projects-design.md

## Global Constraints

- Every `localPath` must realpath-resolve strictly inside `AGENTOS_LOCAL_WORKSPACES_ROOT`; containment is re-checked at every entry point that receives a path (config validation happens structurally only; runtime containment happens in adapters and routes).
- Git operations use plumbing only: `rev-parse`, `ls-tree`, `cat-file`, `hash-object -w`, `mktree`, `commit-tree`, `update-ref`. Never `checkout`, `commit`, `add`, or anything that runs hooks or touches the working tree.
- The GitHub repository identity schema keeps `installationId`/`repositoryId` positive-int requirements unchanged; the local variant is `{ kind: 'local', owner: 'local', name: <basename> }` with no IDs.
- The publication authorization audience for local projects is exactly `local-git-publisher`; GitHub stays `github-publisher`.
- Local publication branch name: `agentos/<runId>-<manifestDigest.slice(0, 8)>`.
- All existing GitHub-path tests must pass unchanged.
- Commit after every task with a conventional-commit message ending in the Claude co-author trailer.

---

### Task 1: Config schema — `project.localPath`

**Files:**
- Modify: `packages/core/src/config.ts:153-159`
- Test: `packages/core/src/config.test.ts`

**Interfaces:**
- Produces: `AgentOsConfig['project']` gains optional `localPath: string`; parse rejects configs with both `repository` and `localPath`.

- [ ] **Step 1: Write failing tests**

```ts
// append to packages/core/src/config.test.ts
describe('local experiment projects', () => {
  it('accepts an absolute localPath without a repository', () => {
    const config = loadAgentOsConfig(`
version: 1
project: { name: exp, localPath: /workspaces/exp }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    expect(config.project.localPath).toBe('/workspaces/exp');
  });

  it('rejects a relative or traversing localPath', () => {
    for (const bad of ['relative/path', '/workspaces/../etc', '/a/./b']) {
      expect(() =>
        loadAgentOsConfig(`
version: 1
project: { name: exp, localPath: ${JSON.stringify(bad)} }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`),
      ).toThrow();
    }
  });

  it('rejects repository and localPath together', () => {
    expect(() =>
      loadAgentOsConfig(`
version: 1
project: { name: exp, repository: https://github.com/o/r, localPath: /w/exp }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`),
    ).toThrow(/localPath|repository/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @agentos/core test -- config` — expect the three new tests to fail (unknown key `localPath` under `.strict()`).

- [ ] **Step 3: Implement**

In `packages/core/src/config.ts`, replace the project object:

```ts
    project: z
      .object({
        name: Identifier,
        repository: z.string().url().optional(),
        // Local experiment projects: an absolute directory path inside the
        // operator's workspaces root. Containment against the root is a
        // runtime check; the schema enforces shape only.
        localPath: z
          .string()
          .min(2)
          .max(1_024)
          .regex(/^\//, 'localPath must be absolute')
          .refine(
            (value) =>
              !value
                .split('/')
                .some((segment) => segment === '..' || segment === '.'),
            'localPath must not contain relative segments',
          )
          .optional(),
        defaultBranch: Identifier.default('main'),
      })
      .strict()
      .refine(
        (value) =>
          value.repository === undefined || value.localPath === undefined,
        'project.repository and project.localPath are mutually exclusive',
      ),
```

- [ ] **Step 4: Run tests** — `pnpm --filter @agentos/core test` — expect all green (canonicalization of the new optional field is covered by existing canonical-JSON round-trip tests).
- [ ] **Step 5: Commit** — `git add packages/core/src/config.ts packages/core/src/config.test.ts && git commit -m "feat(core): add project.localPath for local experiment projects"` (with co-author trailer).

---

### Task 2: Core publication identity union

**Files:**
- Modify: `packages/core/src/publication.ts:98-105` (repository schema) and the exported types near it
- Test: `packages/core/src/publication.test.ts`

**Interfaces:**
- Produces: `publicationRepositorySchema = z.union([githubRepositorySchema, localRepositorySchema])`; type `PublicationRepository = GitHubPublicationRepository | LocalPublicationRepository`; helper `isLocalRepository(value): value is LocalPublicationRepository`.
- Consumers (Tasks 5, 6) narrow with `isLocalRepository`.

- [ ] **Step 1: Write failing tests**

```ts
// append to packages/core/src/publication.test.ts
describe('local repository identity', () => {
  it('accepts the local variant and narrows it', () => {
    const parsed = publicationRepositorySchema.parse({
      kind: 'local',
      owner: 'local',
      name: 'experiment-1',
    });
    expect(isLocalRepository(parsed)).toBe(true);
  });

  it('rejects local variants with GitHub identifiers', () => {
    expect(() =>
      publicationRepositorySchema.parse({
        kind: 'local',
        owner: 'local',
        name: 'x',
        repositoryId: 1,
      }),
    ).toThrow();
  });

  it('keeps rejecting GitHub identities without positive ids', () => {
    expect(() =>
      publicationRepositorySchema.parse({
        owner: 'octo',
        name: 'repo',
        installationId: 0,
        repositoryId: 1,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @agentos/core test -- publication`.

- [ ] **Step 3: Implement**

In `packages/core/src/publication.ts` replace the single `repositorySchema` with:

```ts
const githubRepositorySchema = z
  .object({
    owner: z.string().regex(OWNER, 'invalid repository owner'),
    name: z.string().regex(REPOSITORY, 'invalid repository name'),
    installationId: z.number().int().positive().safe(),
    repositoryId: z.number().int().positive().safe(),
  })
  .strict();
const localRepositorySchema = z
  .object({
    kind: z.literal('local'),
    owner: z.literal('local'),
    name: z.string().regex(REPOSITORY, 'invalid repository name'),
  })
  .strict();
export const publicationRepositorySchema = z.union([
  githubRepositorySchema,
  localRepositorySchema,
]);
export type PublicationRepository = z.infer<typeof publicationRepositorySchema>;
export type LocalPublicationRepository = z.infer<typeof localRepositorySchema>;
export function isLocalRepository(
  value: PublicationRepository,
): value is LocalPublicationRepository {
  return 'kind' in value && value.kind === 'local';
}
```

Then substitute `repositorySchema` with `publicationRepositorySchema` at every internal use (manifest schema, authorization claims schema). Do not change `validatePublicationAuthorization` logic — the repository object participates in canonical binding comparison as-is.

- [ ] **Step 4: Verify the GitHub publisher still narrows.** `packages/adapters/src/github/publisher.ts` and `github-app.ts` consume `manifest.repository.installationId`; add one guard at the top of the publisher's `prepare` (Task 5 relies on it):

```ts
    if (isLocalRepository(manifest.repository))
      rejected('local publications must use the local publisher');
```

- [ ] **Step 5: Run tests** — `pnpm --filter @agentos/core test && pnpm --filter @agentos/adapters test` — all green.
- [ ] **Step 6: Commit** — `feat(core): publication repository identity union with local variant`.

---

### Task 3: Local git plumbing and containment helpers

**Files:**
- Create: `packages/adapters/src/local-git/git.ts`
- Create: `packages/adapters/src/local-git/git.test.ts`
- Create: `packages/adapters/src/local-git/index.ts`
- Modify: `packages/adapters/src/index.ts` (re-export `./local-git/index.js`)

**Interfaces:**
- Produces:
  - `assertContainedRepository(localPath: string, workspacesRoot: string): Promise<string>` — returns the realpath or throws `LocalGitError`.
  - `runGit(repo: string, args: readonly string[], options?: { input?: Uint8Array | string }): Promise<string>` — spawns `git -C <repo> <args>`, trims stdout, throws `LocalGitError` with bounded stderr on non-zero exit. Allowlist of first arguments: `rev-parse`, `ls-tree`, `cat-file`, `hash-object`, `mktree`, `commit-tree`, `update-ref`, `init`, `status`, `config`, `add`, `commit` are NOT all allowed — the allowlist is exactly `['rev-parse', 'ls-tree', 'cat-file', 'hash-object', 'mktree', 'commit-tree', 'update-ref', 'status']`; anything else throws before spawning. (Repository seeding in Task 7 uses its own narrowly-scoped `initializeLocalRepository`, see below.)
  - `class LocalGitError extends Error { readonly code: string }`

- [ ] **Step 1: Write failing tests** — temp-dir fixtures with `node:fs/promises` + a seeded repo built by shelling to system git through a test-only helper:

```ts
// packages/adapters/src/local-git/git.test.ts
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { assertContainedRepository, LocalGitError, runGit } from './git.js';

const exec = promisify(execFile);
const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentos-localgit-'));
  roots.push(root);
  return realpath(root);
}

async function seedRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo);
  await exec('git', ['-C', repo, 'init', '--initial-branch=main']);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'file.txt'), 'hello\n');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'seed']);
  return repo;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('assertContainedRepository', () => {
  it('accepts a repository inside the root', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    await expect(assertContainedRepository(repo, root)).resolves.toBe(
      await realpath(repo),
    );
  });

  it('rejects paths outside the root and symlink escapes', async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    const escapee = await seedRepo(outside, 'outside');
    await expect(assertContainedRepository(escapee, root)).rejects.toThrow(
      LocalGitError,
    );
    await symlink(escapee, join(root, 'link'));
    await expect(
      assertContainedRepository(join(root, 'link'), root),
    ).rejects.toThrow(LocalGitError);
  });

  it('rejects directories that are not git repositories', async () => {
    const root = await fixtureRoot();
    const plain = join(root, 'plain');
    await mkdir(plain);
    await expect(assertContainedRepository(plain, root)).rejects.toThrow(
      /git repository/,
    );
  });
});

describe('runGit', () => {
  it('runs allowlisted plumbing and returns stdout', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const head = await runGit(repo, ['rev-parse', 'HEAD']);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses non-allowlisted subcommands', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    await expect(runGit(repo, ['checkout', 'main'])).rejects.toThrow(
      LocalGitError,
    );
    await expect(runGit(repo, ['commit', '-m', 'x'])).rejects.toThrow(
      LocalGitError,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @agentos/adapters test -- local-git`.

- [ ] **Step 3: Implement `git.ts`**

```ts
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class LocalGitError extends Error {
  override readonly name = 'LocalGitError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const ALLOWED_SUBCOMMANDS = new Set([
  'rev-parse',
  'ls-tree',
  'cat-file',
  'hash-object',
  'mktree',
  'commit-tree',
  'update-ref',
  'status',
]);

/**
 * Containment gate for every local-repository path. Realpath resolution
 * forecloses symlink escapes; the `.git` check refuses bare directories so
 * plumbing always operates on a working repository the operator owns.
 */
export async function assertContainedRepository(
  localPath: string,
  workspacesRoot: string,
): Promise<string> {
  if (!localPath.startsWith('/') || !workspacesRoot.startsWith('/'))
    throw new LocalGitError('containment', 'paths must be absolute');
  let repoReal: string;
  let rootReal: string;
  try {
    rootReal = await realpath(workspacesRoot);
    repoReal = await realpath(localPath);
  } catch {
    throw new LocalGitError('containment', 'path does not exist');
  }
  if (repoReal !== rootReal && !repoReal.startsWith(rootReal + sep))
    throw new LocalGitError(
      'containment',
      'repository is outside the local workspaces root',
    );
  try {
    const info = await stat(join(repoReal, '.git'));
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new LocalGitError(
      'not_a_repository',
      'localPath is not a git repository',
    );
  }
  return repoReal;
}

/**
 * Plumbing-only runner: never checks out, never runs hooks. Uses spawn (not
 * execFile) because hash-object --stdin and mktree read from stdin.
 */
export async function runGit(
  repository: string,
  args: readonly string[],
  options: { readonly input?: Uint8Array | string } = {},
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === undefined || !ALLOWED_SUBCOMMANDS.has(subcommand))
    throw new LocalGitError(
      'forbidden_subcommand',
      `git subcommand is not allowed: ${subcommand ?? '(none)'}`,
    );
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', repository, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const overflow = () => {
      child.kill('SIGKILL');
      rejectPromise(new LocalGitError('git_failed', 'git output too large'));
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 32 * 1024 * 1024) return overflow();
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).byteLength < 16 * 1024) stderr.push(chunk);
    });
    child.on('error', (error) =>
      rejectPromise(new LocalGitError('git_failed', error.message)),
    );
    child.on('close', (code) => {
      if (code === 0)
        return resolvePromise(Buffer.concat(stdout).toString('utf8').trimEnd());
      rejectPromise(
        new LocalGitError(
          'git_failed',
          `git ${subcommand} failed: ${Buffer.concat(stderr)
            .toString('utf8')
            .slice(0, 500)}`,
        ),
      );
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}
```

(Import `spawn` from `node:child_process`; the test-only fixture helper may keep using `execFile` for seeding.)

- [ ] **Step 4: `index.ts` exports** — `export { assertContainedRepository, runGit, LocalGitError } from './git.js';` plus Task 4/5 exports as they land; add `export * from './local-git/index.js';` to `packages/adapters/src/index.ts`.
- [ ] **Step 5: Run tests** — green; then commit `feat(adapters): local git plumbing runner with workspace containment`.

---

### Task 4: Local source snapshot ingestor

**Files:**
- Create: `packages/adapters/src/local-git/source-snapshot.ts`
- Create: `packages/adapters/src/local-git/source-snapshot.test.ts`
- Modify: `packages/adapters/src/trigger/production-handler.ts:61-66` (bundle repository union)
- Modify: `packages/adapters/src/github/source-snapshot.ts:163-167` (emit the GitHub identity unchanged; no code change needed if shape already matches — verify only)

**Interfaces:**
- Consumes: `runGit`, `assertContainedRepository` (Task 3); `ArtifactStore` and `TrustedSourceSnapshotBinding` from the GitHub ingestor module.
- Produces: `createLocalSourceSnapshotIngestor(options: { artifacts: ArtifactStore; workspacesRoot: string; resolveBinding(runId): Promise<LocalSourceSnapshotBinding> }): TrustedSourceSnapshotIngestor` where `LocalSourceSnapshotBinding = { projectId; runId; localPath; baseBranch; repositorySha }`.
- Bundle body emitted: `{ version: 'source-bundle-v1', repository: { kind: 'local', owner: 'local', name: basename(localPath) }, baseBranch, repositorySha, treeSha, files }` — same limits as the GitHub ingestor (`MAX_SOURCE_BUNDLE_BYTES`, `safePath`, text-only, modes `100644|100755`).

- [ ] **Step 1: Write failing tests** — reuse the Task 3 fixture helpers (export them from a `test-support.ts` in `local-git/`): bundle round-trip equality for a seeded repo (two files, one executable); rejection of: SHA that is not the pinned one, a repo containing a symlink, a file with a NUL byte, a bundle over `MAX_SOURCE_BUNDLE_BYTES`; idempotent second `ensure` returns the same artifact metadata (use the in-memory artifact store from `packages/adapters/src/artifacts/in-memory.ts`).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — enumeration:

```ts
const entries = (
  await runGit(repo, ['ls-tree', '-r', '-z', binding.repositorySha])
)
  .split('\0')
  .filter((line) => line !== '');
// each line: `<mode> <type> <sha>\t<path>`
```

Reject any entry whose type is not `blob` or whose mode is not `100644`/`100755` (this rejects symlinks, mode `120000`, and submodules, mode `160000`). Read content with `runGit(repo, ['cat-file', 'blob', sha])`; reject if it contains `\0`. Apply the same `safePath` rules as the GitHub ingestor (import or replicate its checks verbatim). Compute `treeSha = await runGit(repo, ['rev-parse', `${binding.repositorySha}^{tree}`])`. Build the body with `canonicalJsonValue`, enforce `MAX_SOURCE_BUNDLE_BYTES`, and store via `options.artifacts.put({ scope: { projectId, runId, stepId: 'source' }, artifactId: 'bundle', version: 1, bytes, mediaType: 'application/json' })` exactly as `github/source-snapshot.ts:178-187` does.

- [ ] **Step 4: Widen the trigger bundle schema** — in `production-handler.ts` replace the bundle `repository` object with a union mirroring Task 2 (github shape with `repositoryId` positive, or `{ kind: 'local', owner: 'local' literal, name }` strict).
- [ ] **Step 5: Run tests** — `pnpm --filter @agentos/adapters test` all green; commit `feat(adapters): local source snapshot ingestor`.

---

### Task 5: Local git publisher

**Files:**
- Create: `packages/adapters/src/local-git/publisher.ts`
- Create: `packages/adapters/src/local-git/publisher.test.ts`
- Modify: `packages/adapters/src/github/publisher.ts` (the Task 2 narrow guard, if not already landed there)

**Interfaces:**
- Consumes: `parsePublicationManifest`, `validatePublicationAuthorization`, `evaluatePublicationPolicy`, `isLocalRepository` from core; `PublicationStore` from `github/store.ts`; `runGit`/`assertContainedRepository`.
- Produces: `createLocalGitPublisher(options: { workspacesRoot: string; localPath: string; verifier: AttestationVerifier<PublicationAuthorizationClaims>; policy: unknown; store: PublicationStore; now?: () => Date })` with `publish(input: unknown)` returning `{ status: 'succeeded', local: true, branch, commitSha, repositoryUrl: 'file://' + realLocalPath }`.

- [ ] **Step 1: Write failing tests** — seeded temp repo; a manifest + authorization built with the real issuer helpers (mirror `publisher.test.ts` fixtures for HMAC key setup, audience `local-git-publisher`):
  - publishes a change set (add + modify + delete) and: branch `agentos/<runId>-<digest8>` exists, its commit's tree matches the change set, `git status --porcelain` output is unchanged from before the publish (working tree untouched), HEAD still points at the original branch;
  - rejects wrong-audience authorizations (GitHub-audience token);
  - rejects when `expectedBase.sha` no longer equals the default branch head;
  - rejects protected-path changes (e.g. `.github/workflows/x.yml`);
  - replays idempotently: second `publish` with the same manifest returns the same branch/commit without creating a second commit.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — sequence per publish, all through `runGit`:

```
base       = rev-parse <defaultBranch>            # must equal expectedBase.sha
baseTree   = rev-parse <base>^{tree}
entries    = ls-tree -r -z <baseTree>             # path -> {mode, sha}
for each change:
  delete   -> remove path from entries
  add/mod  -> blobSha = hash-object -w --stdin < content ; entries[path] = {mode, blobSha}
treeInput  = lines "<mode> blob <sha>\t<path>" for every entry   # flat -r listing
newTree    = mktree --missing=error (built bottom-up per directory)
commitSha  = commit-tree <newTree> -p <base> -m "Agent OS: <runId>" with
             GIT_AUTHOR_NAME/EMAIL + GIT_COMMITTER_NAME/EMAIL env fixed to
             "Agent OS Publisher" / "agentos@localhost"
update-ref refs/heads/<branch> <commitSha> ""     # last arg guards create-only
```

`mktree` accepts only one directory level per invocation, so build trees bottom-up: group the flat entry list by directory, deepest first, invoking `mktree` per directory and substituting child tree SHAs upward. Persist store phases using only existing `PublicationPhase` values, in the order `claimed` → `blobs_created` → `tree_created` → `branch_created` → `succeeded` (`pr_created` is never used by the local publisher), with the same `save(key, revision, patch, event)` idempotent contract the GitHub publisher uses; on replay, return the recorded branch/commit when the phase is already `succeeded`.

- [ ] **Step 4: Run tests** — adapters suite green; commit `feat(adapters): local git branch publisher`.

---

### Task 6: Workflow result union and composition selection

**Files:**
- Modify: `packages/adapters/src/trigger/schemas.ts:96-108` (result union)
- Modify: `packages/adapters/src/trigger/workflow.ts:1602,1637` (parse sites — rename schema import only)
- Modify: `packages/adapters/src/trigger/production-handler.ts` (publisher + authority + ingest-validation selection by project kind)
- Test: `packages/adapters/src/trigger/production-composition.test.ts` (extend), `packages/adapters/src/trigger/production-handler.test.ts` (extend)

**Interfaces:**
- Produces: `publicationResultSchema = z.union([draftPublicationResultSchema, localPublicationResultSchema])` where:

```ts
export const localPublicationResultSchema = z
  .object({
    status: z.literal('succeeded'),
    local: z.literal(true),
    branch: z.string().min(1).max(512),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    repositoryUrl: z.string().url().max(2_048).startsWith('file://'),
  })
  .strict();
```

- Production handler behavior:
  - `config.project.localPath` set → publisher = `createLocalGitPublisher` (workspacesRoot from `AGENTOS_LOCAL_WORKSPACES_ROOT`, required in this branch); authority stamps `audience: 'local-git-publisher'` and `repository: { kind: 'local', owner: 'local', name: basename(localPath) }`; the `workflowForSnapshot` GitHub-repository check (`production-handler.ts:486-501`) is skipped; `selectedRepositories` (GitHub env) is not required.
  - `config.project.repository` set → existing path verbatim.
  - Neither/both → `throw new Error('project must configure exactly one of repository or localPath')`.

- [ ] **Step 1: Write failing composition tests** — snapshot with `localPath` resolves without GitHub env; snapshot with both fields throws; the authority for a local snapshot issues audience `local-git-publisher` (assert via the verifier).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the schema union, the workflow parse-site rename, and the handler selection. The GitHub-only env requirements (`GITHUB_APP_ID` etc.) move inside the GitHub branch of the selection so a local-only deployment boots without them.
- [ ] **Step 4: Run** — full adapters suite green; commit `feat(adapters): local publication path through workflow composition`.

---

### Task 7: Control-plane wiring, readiness, and setup routes

**Files:**
- Modify: `apps/control-plane/src/application/runtime.ts` (dispatch ingestor selection; head resolver local branch; export `localWorkspacesRootFromEnv()`)
- Modify: `apps/control-plane/src/application/setup-readiness.ts` (GitHub group relabel + local group)
- Create: `apps/control-plane/app/api/setup/local-repository/route.ts`
- Modify: `apps/control-plane/app/api/setup/repository-head/route.ts` (local branch)
- Test: `apps/control-plane/src/http/setup-routes.test.ts` (extend)

**Interfaces:**
- `localWorkspacesRootFromEnv(): string | undefined` — trimmed `AGENTOS_LOCAL_WORKSPACES_ROOT` or undefined.
- Dispatch: in `workflowDispatchFromEnv`'s `resolveBinding`, after parsing the config, branch: `config.project.localPath` → `createLocalSourceSnapshotIngestor` binding; else current GitHub ingestor. Structure as one ingestor facade `{ ensure(runId) }` that resolves the run's config first and delegates.
- `POST /api/setup/local-repository` body `{ name: /^[a-z0-9][a-z0-9-]{0,63}$/ }`; session/API auth; requires workspaces root; creates `<root>/<name>` (409 if exists), runs `git init --initial-branch=main`, writes seed `package.json` (`{"name": name, "private": true, "type": "module", "scripts": {"test": "node --test"}}` plus `packageManager` matching the repo toolchain), `test/smoke.test.mjs` (one passing `node:test` case), an initial commit authored "Agent OS Setup <agentos@localhost>" via a narrowly-scoped `initializeLocalRepository` helper in `local-git` (this helper may use `init`/`add`/`commit` but only on a directory it just created inside the root — it never runs on pre-existing repositories); responds `{ localPath, headSha, branch: 'main' }`.
- `GET /api/setup/repository-head` — if the active config has `localPath`: containment-check, `runGit(repo, ['rev-parse', defaultBranch])`, respond `{ repository: 'local/' + basename, branch, repositorySha }`; else existing GitHub path.
- Readiness: GitHub group `title` becomes `'GitHub Apps (GitHub projects)'`; new group `local` / `'Local workspaces (experiments)'` with the single item `AGENTOS_LOCAL_WORKSPACES_ROOT` (hint: `'Absolute directory that contains local experiment repositories.'`). Top-level `ready` stays the conjunction of all groups EXCEPT `github` and `local`; add `readyForGitHub` and `readyForLocal` booleans (`ready && github.ready`, `ready && local.ready`).

- [ ] **Step 1: Write failing route tests** — local-repository: 401 unauthenticated; 409 without root; creates and returns a 40-hex `headSha` with a real temp root stubbed via `vi.stubEnv`; containment rejection for `name` values like `'..'` (schema regex rejects). Readiness: `readyForLocal` true with root + non-GitHub groups, GitHub group missing.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `pnpm --filter @agentos/control-plane test` green; commit `feat(control-plane): local experiment wiring, readiness, and setup endpoints`.

---

### Task 8: Wizard project-type toggle

**Files:**
- Modify: `apps/control-plane/src/ui/setup-wizard.tsx`
- Create: `apps/control-plane/src/ui/setup-template-local.ts` (template with `localPath: /REPLACE/WITH/ABSOLUTE/PATH` in place of `repository:`; generated the same way `setup-template.ts` was)
- Modify: `apps/control-plane/src/ui/setup-wizard.tsx` step copy

**Steps:**

- [ ] **Step 1: Add mode state** — `const [mode, setMode] = useState<'github' | 'local'>('github')`; radio-style buttons at the top of Step 2; switching modes swaps the textarea template (only when the textarea still equals the untouched other-mode template, so operator edits are never clobbered).
- [ ] **Step 2: Local-mode readiness gating** — Step 1 uses `readyForLocal`/`readyForGitHub` from the readiness payload according to `mode`; unmet GitHub items are shown but do not block local mode (and vice versa).
- [ ] **Step 3: Create-repository action** — in local mode, above the textarea: name input + "Create local repository" button calling `POST /api/setup/local-repository`; on success, substitute the returned `localPath` into the template's `localPath:` line and show the returned `headSha`.
- [ ] **Step 4: Local head + copy** — Step 3 works unchanged (endpoint handles both kinds); Step 4 success copy for local runs says "the run ends as a local branch — inspect it with `git log agentos/<runId>…`". Add the honest-caveat line to local mode copy: "Local repository, cloud execution: sessions run in the Managed Agents sandbox and artifacts are stored in R2."
- [ ] **Step 5: Verify** — `pnpm --filter @agentos/control-plane lint && pnpm --filter @agentos/control-plane typecheck && pnpm --filter @agentos/control-plane test`; load `/setup` in the browser and walk both modes visually.
- [ ] **Step 6: Commit** — `feat(control-plane): setup wizard local experiment mode`.

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `README.md` (quick-start: local experiment lane sentence)
- Modify: `docs/architecture/durable-feature-workflow.md` (local publication paragraph)
- Modify: `docs/progress.md` (entry)

**Steps:**

- [ ] **Step 1: Docs** — README gains, under Full stack: "Local experiment projects: set `AGENTOS_LOCAL_WORKSPACES_ROOT`, choose 'Local experiment' in the setup wizard, and runs end as `agentos/<run>` branches in a local repository instead of draft PRs (sessions still execute in the Managed Agents cloud)."
- [ ] **Step 2: Full verification** — `pnpm test` at the repo root (all packages); `pnpm --filter @agentos/control-plane lint`.
- [ ] **Step 3: Live smoke** — create a local repo through the wizard, run one feature ("Add a constant module"), approve the spec, verify the run succeeds and `git -C <repo> log --oneline agentos/<runId>-*` shows the commit with the change set, and `git -C <repo> status --porcelain` is empty.
- [ ] **Step 4: Commit** — `docs: local experiment projects`.
