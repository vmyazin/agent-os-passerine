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

interface SubcommandRule {
  /** Exact-match tokens (flags, or safe positional keywords) always allowed. */
  readonly flags: readonly string[];
  /** Whether arguments outside `flags` are permitted at all, as long as they
   * don't start with '-'. `hash-object` sets this false so content can only
   * ever arrive via stdin, never via a filesystem path argument. */
  readonly allowPositional: boolean;
  /** Flags that must be present for the call to be considered safe. */
  readonly requiredFlags?: readonly string[];
}

const SUBCOMMAND_RULES: Record<string, SubcommandRule> = {
  'rev-parse': { flags: [], allowPositional: true },
  'ls-tree': { flags: ['-r', '-l', '-z'], allowPositional: true },
  'cat-file': {
    flags: ['-p', '-t', '--batch', 'blob', 'commit', 'tree'],
    allowPositional: true,
  },
  'hash-object': {
    flags: ['-w', '--stdin'],
    allowPositional: false,
    requiredFlags: ['--stdin'],
  },
  mktree: { flags: ['-z', '--missing', '--missing=error'], allowPositional: true },
  'commit-tree': { flags: ['-p', '-m'], allowPositional: true },
  'update-ref': { flags: [], allowPositional: true },
  status: { flags: ['--porcelain'], allowPositional: true },
};

const ALLOWED_SUBCOMMANDS = new Set(Object.keys(SUBCOMMAND_RULES));

const MAX_ARGUMENT_LENGTH = 4096;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_OBJECTS = 5_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

interface RunGitOptions {
  readonly input?: Uint8Array | string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Only the git identity/date variables needed to stamp a deterministic,
 * content-addressed author/committer on plumbing-created commits (see
 * local-git/publisher.ts) may be injected. The date keys matter as much as
 * the name/email ones: `git commit-tree` defaults to the current wall-clock
 * time when no date is given, which would make retries of the *same*
 * (tree, parent, message) produce a *different* commit sha each time --
 * defeating the resume logic that relies on commit-tree being genuinely
 * idempotent. Anything else (e.g. GIT_SSH_COMMAND, GIT_ALTERNATE_OBJECT_
 * DIRECTORIES) could change how git resolves objects or talks to the
 * network, which would defeat the containment/allowlisting done elsewhere
 * in this file.
 */
const ALLOWED_ENV_KEYS = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

function assertSafeEnv(env: Readonly<Record<string, string>> | undefined): void {
  if (env === undefined) return;
  for (const [envKey, value] of Object.entries(env)) {
    if (!ALLOWED_ENV_KEYS.has(envKey))
      throw new LocalGitError(
        'forbidden_argument',
        `git environment variable is not allowed: ${envKey}`,
      );
    if (value.length > MAX_ARGUMENT_LENGTH || /[\0\n]/.test(value))
      throw new LocalGitError(
        'forbidden_argument',
        `git environment value for ${envKey} is too long or contains forbidden characters`,
      );
  }
}

/**
 * Per-subcommand argument allowlisting. The subcommand allowlist alone is
 * not enough: e.g. `hash-object <path>` reads an arbitrary file into the
 * object store (retrievable via cat-file) without ever touching
 * assertContainedRepository, which only validates the repository path, not
 * plumbing arguments. Every argument must either be a known-safe flag for
 * its subcommand, or (where positionals are allowed at all) a value that
 * does not look like a flag and is bounded in size and character content.
 */
function assertSafeArguments(subcommand: string, rest: readonly string[]): void {
  const rule = SUBCOMMAND_RULES[subcommand];
  if (rule === undefined)
    throw new LocalGitError(
      'forbidden_subcommand',
      `git subcommand is not allowed: ${subcommand}`,
    );
  for (const arg of rest) {
    if (arg.length > MAX_ARGUMENT_LENGTH || /[\0\n]/.test(arg))
      throw new LocalGitError(
        'forbidden_argument',
        `argument to git ${subcommand} is too long or contains forbidden characters`,
      );
    if (rule.flags.includes(arg)) continue;
    if (!rule.allowPositional || arg.startsWith('-'))
      throw new LocalGitError(
        'forbidden_argument',
        `argument is not allowed for git ${subcommand}: ${arg}`,
      );
  }
  for (const required of rule.requiredFlags ?? [])
    if (!rest.includes(required))
      throw new LocalGitError(
        'forbidden_argument',
        `git ${subcommand} requires ${required}`,
      );
}

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

async function runGitBuffer(
  repository: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<Buffer> {
  const subcommand = args[0];
  if (subcommand === undefined || !ALLOWED_SUBCOMMANDS.has(subcommand))
    throw new LocalGitError(
      'forbidden_subcommand',
      `git subcommand is not allowed: ${subcommand ?? '(none)'}`,
    );
  assertSafeArguments(subcommand, args.slice(1));
  assertSafeEnv(options.env);
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', repository, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env:
        options.env === undefined
          ? process.env
          : { ...process.env, ...options.env },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const resolveOnce = (value: Buffer) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const rejectOnce = (error: LocalGitError) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const overflow = () => {
      child.kill('SIGKILL');
      rejectOnce(new LocalGitError('git_failed', 'git output too large'));
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) return overflow();
      if (settled) return;
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 16 * 1024) return;
      const remaining = 16 * 1024 - stderrBytes;
      const bounded = chunk.subarray(0, remaining);
      stderr.push(bounded);
      stderrBytes += bounded.byteLength;
    });
    child.on('error', (error) =>
      rejectOnce(new LocalGitError('git_failed', error.message)),
    );
    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) return resolveOnce(Buffer.concat(stdout));
      rejectOnce(
        new LocalGitError(
          'git_failed',
          `git ${subcommand} failed: ${Buffer.concat(stderr)
            .toString('utf8')
            .slice(0, 500)}`,
        ),
      );
    });
    // Without this handler, an EPIPE while writing (e.g. the process died
    // before we finished writing input) becomes an uncaught exception
    // rather than surfacing through the 'error'/'close' handlers above.
    child.stdin.on('error', () => {});
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

/**
 * Plumbing-only runner: never checks out, never runs hooks. Uses spawn (not
 * execFile) because hash-object --stdin and mktree read from stdin.
 */
export async function runGit(
  repository: string,
  args: readonly string[],
  options: RunGitOptions & {
    /** When true, resolves with stdout decoded as UTF-8 exactly as
     * received, with no `trimEnd()` applied. Defaults to false, preserving
     * the historical trimmed behavior every other caller relies on. */
    readonly raw?: boolean;
  } = {},
): Promise<string> {
  const output = await runGitBuffer(repository, args, options);
  const text = output.toString('utf8');
  return options.raw === true ? text : text.trimEnd();
}

function malformedBatch(): never {
  throw new LocalGitError(
    'git_failed',
    'git cat-file batch output is malformed',
  );
}

export function parseGitBlobBatch(
  raw: Uint8Array,
  expectedObjectIds: readonly string[],
): readonly Uint8Array[] {
  const output = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const expected of expectedObjectIds) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1 || newline - offset > 128) malformedBatch();
    const header = output.subarray(offset, newline).toString('ascii');
    const match = /^([0-9a-f]{40}) ([a-z-]+) ([0-9]+)$/.exec(header);
    const objectId = match?.[1];
    const type = match?.[2];
    const size = Number(match?.[3]);
    if (
      objectId !== expected ||
      type !== 'blob' ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      malformedBatch();
    const bodyStart = newline + 1;
    const bodyEnd = bodyStart + size;
    if (
      !Number.isSafeInteger(bodyEnd) ||
      bodyEnd >= output.byteLength ||
      output[bodyEnd] !== 0x0a
    )
      malformedBatch();
    blobs.push(output.subarray(bodyStart, bodyEnd));
    offset = bodyEnd + 1;
  }
  if (offset !== output.byteLength) malformedBatch();
  return blobs;
}

/**
 * Reads a validated set of full blob object IDs through one fixed Git batch
 * process. No repository-controlled value can select a command or flag.
 */
export async function readGitBlobs(
  repository: string,
  objectIds: readonly string[],
): Promise<readonly Uint8Array[]> {
  if (
    objectIds.length > MAX_BATCH_OBJECTS ||
    objectIds.some((objectId) => !SHA_PATTERN.test(objectId))
  )
    throw new LocalGitError(
      'forbidden_argument',
      'git batch object list is invalid',
    );
  if (objectIds.length === 0) return [];
  const output = await runGitBuffer(repository, ['cat-file', '--batch'], {
    input: `${objectIds.join('\n')}\n`,
  });
  return parseGitBlobBatch(output, objectIds);
}
