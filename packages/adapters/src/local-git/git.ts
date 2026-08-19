import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

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
