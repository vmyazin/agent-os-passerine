import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Thrown when `initializeLocalRepository`'s target directory already
 * exists. Distinguishable from every other failure mode so callers (e.g.
 * the `POST /api/setup/local-repository` route) can map it to a 409
 * without pattern-matching an error message. */
export class LocalRepositoryAlreadyExistsError extends Error {
  override readonly name = 'LocalRepositoryAlreadyExistsError';
  constructor(message: string) {
    super(message);
  }
}

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
 * Every `git` invocation in this module runs with the operator's global and
 * system git config disabled (`GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`
 * pointed at `/dev/null`), so a `commit.gpgsign`, `init.templateDir`,
 * `core.hooksPath`, or any other machine-local setting the operator has
 * configured can never surprise a brand-new experiment repo -- every repo
 * this function creates starts from the same clean slate regardless of
 * whose machine it runs on. Computed fresh on every call (not memoized at
 * module scope) so it always reflects the current process environment.
 */
function gitExecEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

function isEexist(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

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
 *
 * Existence check and cleanup: `mkdir` itself is the only existence check
 * (no separate `stat`-then-`mkdir`, which would be a TOCTOU race) --
 * `EEXIST` is translated into `LocalRepositoryAlreadyExistsError`, every
 * other `mkdir` failure propagates unchanged. Once `mkdir` has succeeded,
 * any failure in the steps that follow (git failing, a write failing, an
 * unexpected HEAD shape) is caught, the directory it just created is
 * removed (`rm -rf`), and the original error is rethrown -- a failed
 * initialization never leaves a half-seeded directory behind that would
 * permanently 409 every later attempt to use that name.
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

  try {
    // No `recursive: true`: this is the sole, atomic existence check.
    await mkdir(repo);
  } catch (error) {
    if (isEexist(error))
      throw new LocalRepositoryAlreadyExistsError(
        `a local repository named "${options.name}" already exists`,
      );
    throw error;
  }

  try {
    await exec('git', ['-C', repo, 'init', '--initial-branch=main'], {
      env: gitExecEnv(),
    });
    // Local (repo-scoped) config only -- never --global -- so this never
    // touches the operator's own git identity.
    await exec(
      'git',
      ['-C', repo, 'config', 'user.email', 'agentos@localhost'],
      { env: gitExecEnv() },
    );
    await exec(
      'git',
      ['-C', repo, 'config', 'user.name', 'Agent OS Setup'],
      { env: gitExecEnv() },
    );

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

    await exec('git', ['-C', repo, 'add', '-A'], { env: gitExecEnv() });
    await exec(
      'git',
      ['-C', repo, 'commit', '-m', 'Initialize experiment repository'],
      { env: gitExecEnv() },
    );

    const { stdout } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      env: gitExecEnv(),
    });
    const headSha = stdout.trim();
    if (!SHA_PATTERN.test(headSha))
      throw new Error('git rev-parse did not return a commit SHA');

    return { localPath: repo, branch: 'main', headSha };
  } catch (error) {
    await rm(repo, { recursive: true, force: true });
    throw error;
  }
}
