import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isLocalhostBypassAllowed } from '../auth/auth';

/**
 * Runs the code a run delivered, so the operator can look at it.
 *
 * A finished run leaves a branch. A diff answers whether the change reads
 * correctly; it does not answer whether the thing works. This checks the
 * branch out in a scratch worktree, installs it, and starts whatever server
 * script the project declares.
 *
 * The boundary this crosses is real and deliberate: the pipeline goes to
 * considerable trouble to keep model-written code inside a sandbox, and this
 * runs it on the operator's own machine outside one. It is therefore gated
 * exactly like the folder picker -- a browser session on a localhost
 * deployment, never in production -- and it is an explicit operator action on
 * a repository they own, never something a run can trigger for itself. Sealed
 * verification has already run the project's suite and the frozen acceptance
 * tests inside a sandbox; this is for seeing the result, not for deciding
 * whether it is safe.
 */

const PREVIEW_SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview'] as const;
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_PREVIEWS = 4;

export class RunPreviewError extends Error {
  override readonly name = 'RunPreviewError';

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface RunPreview {
  readonly runId: string;
  readonly branch: string;
  readonly worktree: string;
  /** Absent when the project declares no server script. */
  readonly url?: string;
  readonly script?: string;
  readonly startedAt: string;
  readonly status: 'running' | 'no_server';
  /** What to run by hand when there is no server to start. */
  readonly hint?: string;
  /**
   * HTTP status the server gave for `/` once it came up. Many delivered apps
   * are APIs with no root route, and a bare 404 in a new tab reads as "the
   * preview is broken" when it is the app answering exactly as specified.
   */
  readonly rootStatus?: number;
}

interface ActivePreview extends RunPreview {
  readonly repository: string;
  readonly child?: ChildProcess;
  rootStatus?: number;
}

// Module state: one preview per run, for as long as this process lives. A
// server restart loses the handles, which is why stop() also prunes the
// worktree by path rather than trusting the map alone.
const previews = new Map<string, ActivePreview>();

// When this process goes down, so do its previews. Without this, restarting
// the control plane (a dev-server reload, a deploy) leaves every preview's
// server running on its port and its checkout registered in the operator's
// repository, with nothing left that remembers either. Only synchronous work
// is possible in an exit handler, hence spawnSync; the git call is best
// effort and the directory removal is what actually matters.
let shutdownRegistered = false;
function registerShutdownCleanup(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const tearDown = () => {
    for (const active of previews.values()) {
      active.child?.kill('SIGTERM');
      spawnSync(
        'git',
        [
          '-C',
          active.repository,
          'worktree',
          'remove',
          '--force',
          active.worktree,
        ],
        { stdio: 'ignore', timeout: 5_000 },
      );
    }
    previews.clear();
  };
  process.once('exit', tearDown);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      tearDown();
      process.exit(0);
    });
  }
}

export function isRunPreviewAvailable(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return isLocalhostBypassAllowed(environment);
}

export function getRunPreview(runId: string): RunPreview | undefined {
  const active = previews.get(runId);
  if (active === undefined) return undefined;
  // Built field by field rather than by omission: the child process handle and
  // the repository path are internals, and a spread would leak whatever is
  // added to ActivePreview next.
  return {
    runId: active.runId,
    branch: active.branch,
    worktree: active.worktree,
    startedAt: active.startedAt,
    status: active.status,
    ...(active.url === undefined ? {} : { url: active.url }),
    ...(active.script === undefined ? {} : { script: active.script }),
    ...(active.hint === undefined ? {} : { hint: active.hint }),
    ...(active.rootStatus === undefined
      ? {}
      : { rootStatus: active.rootStatus }),
  };
}

/**
 * Waits briefly for the server to answer `/` and records what it said. Any
 * HTTP status counts as "up"; a server that never answers within the window
 * simply leaves the field unset, and the operator sees the link as before.
 */
async function probeRoot(url: string): Promise<number | undefined> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1_000),
      });
      return response.status;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return undefined;
}

export function listRunPreviews(): readonly RunPreview[] {
  return [...previews.keys()]
    .map((runId) => getRunPreview(runId))
    .filter((preview): preview is RunPreview => preview !== undefined);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve a port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function execute(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: 'ignore',
      shell: false,
      timeout: options.timeoutMs,
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${command} exited with ${String(code ?? 'signal')}`),
          ),
    );
  });
}

/**
 * Starts a preview of one run's published branch. Idempotent per run: asking
 * twice returns the preview that is already running rather than starting a
 * second copy on a second port.
 */
export async function startRunPreview(input: {
  readonly runId: string;
  readonly repository: string;
  readonly branch: string;
  readonly now?: () => string;
}): Promise<RunPreview> {
  const existing = getRunPreview(input.runId);
  if (existing !== undefined) return existing;
  registerShutdownCleanup();
  if (previews.size >= MAX_PREVIEWS)
    throw new RunPreviewError(
      'preview_limit_reached',
      `Stop one of the ${String(MAX_PREVIEWS)} running previews before starting another.`,
      409,
    );

  const worktree = await mkdtemp(join(tmpdir(), 'agentos-preview-'));
  const now = input.now ?? (() => new Date().toISOString());
  const discard = async () => {
    await execute(
      'git',
      ['-C', input.repository, 'worktree', 'remove', '--force', worktree],
      {
        cwd: input.repository,
        timeoutMs: 30_000,
      },
    ).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    // --detach leaves the branch exactly where the publisher put it, so a
    // preview can never move or lock what the operator is about to review.
    await execute(
      'git',
      [
        '-C',
        input.repository,
        'worktree',
        'add',
        '--detach',
        worktree,
        input.branch,
      ],
      { cwd: input.repository, timeoutMs: 60_000 },
    );
  } catch {
    await discard();
    throw new RunPreviewError(
      'preview_checkout_failed',
      'Could not check out the run’s branch.',
      503,
    );
  }

  const manifestPath = join(worktree, 'package.json');
  if (!existsSync(manifestPath)) {
    const preview: ActivePreview = {
      runId: input.runId,
      repository: input.repository,
      branch: input.branch,
      worktree,
      startedAt: now(),
      status: 'no_server',
      hint: `No package.json in this branch. Its files are at ${worktree}.`,
    };
    previews.set(input.runId, preview);
    return getRunPreview(input.runId)!;
  }

  let scripts: Record<string, unknown> = {};
  let hasDependencies: boolean;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
    };
    scripts = manifest.scripts ?? {};
    hasDependencies = Object.keys(manifest.dependencies ?? {}).length > 0;
  } catch {
    await discard();
    throw new RunPreviewError(
      'preview_manifest_invalid',
      'This branch’s package.json could not be read.',
      422,
    );
  }

  const script = PREVIEW_SCRIPT_ORDER.find(
    (name) => typeof scripts[name] === 'string',
  );
  if (script === undefined) {
    const preview: ActivePreview = {
      runId: input.runId,
      repository: input.repository,
      branch: input.branch,
      worktree,
      startedAt: now(),
      status: 'no_server',
      hint: `This project declares no dev or start script. Run its tests with: cd ${worktree} && pnpm test`,
    };
    previews.set(input.runId, preview);
    return getRunPreview(input.runId)!;
  }

  if (hasDependencies || existsSync(join(worktree, 'pnpm-lock.yaml'))) {
    try {
      // --ignore-scripts: a lifecycle hook is arbitrary code that would run
      // before the operator has seen anything at all.
      await execute('pnpm', ['install', '--ignore-scripts'], {
        cwd: worktree,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
    } catch {
      await discard();
      throw new RunPreviewError(
        'preview_install_failed',
        'Dependencies for this branch could not be installed.',
        503,
      );
    }
  }

  const port = await freePort();
  const child = spawn('pnpm', ['run', script], {
    cwd: worktree,
    stdio: 'ignore',
    shell: false,
    detached: false,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development' },
  });
  child.on('error', () => {
    previews.delete(input.runId);
    void discard();
  });
  child.on('close', () => {
    previews.delete(input.runId);
    void discard();
  });

  const preview: ActivePreview = {
    runId: input.runId,
    repository: input.repository,
    branch: input.branch,
    worktree,
    url: `http://localhost:${String(port)}`,
    script,
    startedAt: now(),
    status: 'running',
    child,
  };
  previews.set(input.runId, preview);
  const rootStatus = await probeRoot(preview.url!);
  if (rootStatus !== undefined) preview.rootStatus = rootStatus;
  return getRunPreview(input.runId)!;
}

/** Stops a preview and removes its checkout. Safe to call when none exists. */
export async function stopRunPreview(runId: string): Promise<void> {
  const active = previews.get(runId);
  if (active === undefined) return;
  previews.delete(runId);
  active.child?.removeAllListeners('close');
  active.child?.kill('SIGTERM');
  await execute(
    'git',
    ['-C', active.repository, 'worktree', 'remove', '--force', active.worktree],
    { cwd: active.repository, timeoutMs: 30_000 },
  ).catch(() => undefined);
  await rm(active.worktree, { recursive: true, force: true }).catch(
    () => undefined,
  );
}
