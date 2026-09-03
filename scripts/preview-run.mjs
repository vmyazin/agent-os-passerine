#!/usr/bin/env node
/**
 * Check out what a run delivered and run it.
 *
 * A finished run leaves a branch, which is the right place for code to sit
 * while a human decides about it, and the wrong place to answer "does it
 * actually work". This puts the branch in a scratch worktree, installs it,
 * starts whatever script it declares, and hands back a URL.
 *
 *   pnpm preview <runId> [--port 4173] [--script dev]
 *
 * SAFETY, stated plainly: this executes model-written code on your machine,
 * outside the sandbox the pipeline was careful to keep it inside. The run's
 * own verification already ran the project's suite and the frozen acceptance
 * tests in that sandbox; this is for looking at the result with your own
 * eyes, on a repository you own. Do not point it at a branch you have not
 * read.
 *
 * The worktree is removed on exit, so nothing accumulates and the operator's
 * own checkout is never touched.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(`preview: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const positional = [];
  const options = { port: '4173', script: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--port') options.port = argv[(index += 1)];
    else if (value === '--script') options.script = argv[(index += 1)];
    else if (value.startsWith('--')) fail(`unknown option ${value}`);
    else positional.push(value);
  }
  if (positional.length !== 1)
    fail('usage: pnpm preview <runId> [--port 4173] [--script dev]');
  return { runId: positional[0], ...options };
}

/** Reads AGENTOS_URL / AGENTOS_API_TOKEN from the environment or .env.local. */
function connection() {
  let url = process.env.AGENTOS_URL?.trim();
  let token = process.env.AGENTOS_API_TOKEN?.trim();
  if (!url || !token) {
    for (const candidate of ['.env.local', '../.env.local']) {
      if (!existsSync(candidate)) continue;
      for (const line of readFileSync(candidate, 'utf8').split('\n')) {
        const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (!match) continue;
        if (match[1] === 'AGENTOS_URL' && !url) url = match[2].trim();
        if (match[1] === 'AGENTOS_API_TOKEN' && !token) token = match[2].trim();
      }
      break;
    }
  }
  if (!url || !token)
    fail(
      'set AGENTOS_URL and AGENTOS_API_TOKEN (or run from a repo with .env.local)',
    );
  return { url: url.replace(/\/$/, ''), token };
}

async function execGit(repository, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repository, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('close', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`git ${args.join(' ')} failed: ${err.trim()}`)),
    );
  });
}

async function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const { runId, port, script } = parseArguments(process.argv.slice(2));
const { url, token } = connection();

const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!response.ok)
  fail(
    `could not read ${runId} (${String(response.status)}); is the control plane running at ${url}?`,
  );
const runRecord = await response.json();
const outcome = runRecord.outcome ?? {};
const branch = outcome.publishedBranch ?? outcome.localBranch;
const repositoryUrl = outcome.localRepositoryUrl;

if (runRecord.status !== 'succeeded')
  fail(
    `run ${runId} is ${String(runRecord.status)}; only a succeeded run has something to preview`,
  );
if (!branch || !repositoryUrl)
  fail(
    `run ${runId} published nothing to preview (a GitHub run's result lives in its draft pull request, not on this machine)`,
  );

const repository = fileURLToPath(repositoryUrl);
const worktree = await mkdtemp(join(tmpdir(), 'agentos-preview-'));
let removed = false;
const cleanup = () => {
  if (removed) return;
  removed = true;
  try {
    spawn(
      'git',
      ['-C', repository, 'worktree', 'remove', '--force', worktree],
      {
        stdio: 'ignore',
      },
    ).unref();
  } catch {
    /* best effort */
  }
  try {
    rmSync(worktree, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}

// --detach: the branch stays exactly where the publisher left it, and two
// previews of the same branch do not fight over a checkout.
await execGit(repository, ['worktree', 'add', '--detach', worktree, branch]);
console.log(`preview: ${branch}`);
console.log(`preview: from ${repository}`);
console.log(`preview: checked out at ${worktree}`);

const manifestPath = join(worktree, 'package.json');
if (!existsSync(manifestPath)) {
  console.log('preview: no package.json — nothing to start. Files are above.');
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const scripts = manifest.scripts ?? {};
const chosen =
  script ?? ['dev', 'start', 'serve', 'preview'].find((name) => scripts[name]);

if (existsSync(join(worktree, 'pnpm-lock.yaml')) || manifest.dependencies) {
  console.log('preview: installing dependencies…');
  await run('pnpm', ['install', '--ignore-scripts'], { cwd: worktree });
}

if (!chosen || !scripts[chosen]) {
  // Nothing to serve, so there is nothing to keep a process alive for. Leave
  // the checkout in place instead: a path that is deleted the moment this
  // prints it is worse than no path at all.
  removed = true;
  console.log(
    `preview: this project declares no dev/start script (has: ${Object.keys(scripts).join(', ') || 'none'}).`,
  );
  console.log(`preview: inspect it:   cd ${worktree}`);
  console.log(`preview: run its tests: cd ${worktree} && pnpm test`);
  console.log(
    `preview: discard it:   git -C ${repository} worktree remove --force ${worktree}`,
  );
  process.exit(0);
}

console.log(`preview: starting "${chosen}" on port ${port}…`);
console.log(`preview: http://localhost:${port}`);
console.log('preview: Ctrl+C stops it and removes the checkout.');
const code = await run('pnpm', ['run', chosen], {
  cwd: worktree,
  env: { ...process.env, PORT: port },
});
cleanup();
process.exit(code);
