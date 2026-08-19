import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface InitializeLocalRepositoryOptions {
  readonly workspacesRoot: string;
  readonly name: string;
  /** Copied verbatim into the seed package.json's `packageManager` field
   * when given (e.g. the monorepo root package.json's own value), so the
   * experiment repo's toolchain pin matches the operator's. Omitted
   * entirely when not given, rather than guessed at. */
  readonly packageManagerLine?: string;
}

export interface InitializeLocalRepositoryResult {
  readonly localPath: string;
  readonly branch: 'main';
  readonly headSha: string;
}

const SMOKE_TEST_SOURCE = `import { test } from 'node:test';
import assert from 'node:assert/strict';

test('smoke', () => {
  assert.equal(1 + 1, 2);
});
`;

/**
 * Creates and seeds a brand-new local experiment repository inside
 * `workspacesRoot`, and returns its initial HEAD.
 *
 * Unlike every other export in this directory, this helper calls
 * `git init` / `git config` / `git add` / `git commit` directly via
 * `execFile` instead of going through the plumbing-only allowlist in
 * ./git.ts (`runGit` deliberately does not allow any of those subcommands).
 * That is safe here, and only here, because of an invariant this function
 * both enforces and never violates: every git invocation below runs inside
 * a directory *this same call* creates moments earlier -- never against a
 * pre-existing repository an operator (or attacker) supplied. `runGit`'s
 * allowlist exists to bound what an externally-supplied `localPath` can
 * make git do (see the source-snapshot ingestor and the local publisher,
 * both of which operate on operator-provided repositories); that threat
 * model does not apply to a directory whose entire contents this function
 * just wrote and whose git identity it just set to a fixed, non-secret
 * value.
 *
 * Containment: `name` is validated against the same
 * `^[a-z0-9][a-z0-9-]{0,63}$` pattern the `POST /api/setup/local-repository`
 * route's request schema enforces, which rules out `.`, `..`, `/`, and every
 * other path-traversal or absolute-path shape -- so `join(workspacesRoot,
 * name)` is lexically guaranteed to be a direct child of `workspacesRoot`.
 * There is nothing to `realpath` for a symlink-escape check the way
 * `assertContainedRepository` does: that helper defends paths that already
 * exist and may have been tampered with by something else; the directory
 * this function creates does not exist until the `mkdir` call below
 * succeeds, and this function is the only writer of it from that point on.
 */
export async function initializeLocalRepository(
  options: InitializeLocalRepositoryOptions,
): Promise<InitializeLocalRepositoryResult> {
  if (!NAME_PATTERN.test(options.name))
    throw new Error(
      'repository name must match ^[a-z0-9][a-z0-9-]{0,63}$',
    );
  if (!options.workspacesRoot.startsWith('/'))
    throw new Error('workspacesRoot must be an absolute path');

  const repo = join(options.workspacesRoot, options.name);
  // No `recursive: true`: this must fail loudly if the target already
  // exists rather than silently reusing/mutating a directory it did not
  // create.
  await mkdir(repo);

  await exec('git', ['-C', repo, 'init', '--initial-branch=main']);
  // Local (repo-scoped) config only -- never --global -- so this never
  // touches the operator's own git identity.
  await exec('git', [
    '-C',
    repo,
    'config',
    'user.email',
    'agentos@localhost',
  ]);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Agent OS Setup']);

  const packageJson: Record<string, unknown> = {
    name: options.name,
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  };
  if (options.packageManagerLine !== undefined)
    packageJson.packageManager = options.packageManagerLine;
  await writeFile(
    join(repo, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );

  await mkdir(join(repo, 'test'));
  await writeFile(
    join(repo, 'test', 'smoke.test.mjs'),
    SMOKE_TEST_SOURCE,
    'utf8',
  );

  await exec('git', ['-C', repo, 'add', '-A']);
  await exec('git', [
    '-C',
    repo,
    'commit',
    '-m',
    'Initialize experiment repository',
  ]);

  const { stdout } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD']);
  const headSha = stdout.trim();
  if (!SHA_PATTERN.test(headSha))
    throw new Error('git rev-parse did not return a commit SHA');

  return { localPath: repo, branch: 'main', headSha };
}
