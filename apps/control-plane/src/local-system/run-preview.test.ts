import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getRunPreview,
  isRunPreviewAvailable,
  listRunPreviews,
  startRunPreview,
  stopRunPreview,
} from './run-preview';

const run = promisify(execFile);
const repositories: string[] = [];
const startedRunIds: string[] = [];

/**
 * A real git repository with one published branch, because every failure this
 * module can have is a git or filesystem failure. A fake would assert only
 * that the arguments were spelled correctly.
 */
async function publishedRepository(
  files: Readonly<Record<string, string>>,
): Promise<{ readonly repository: string; readonly branch: string }> {
  const repository = await mkdtemp(join(tmpdir(), 'agentos-source-repo-'));
  repositories.push(repository);
  const git = (...args: string[]) =>
    run('git', ['-C', repository, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@localhost',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@localhost',
      },
    });
  await git('init', '--initial-branch=main');
  await writeFile(join(repository, 'README.md'), '# base\n', 'utf8');
  await git('add', '.');
  await git('commit', '-m', 'base');
  await git('checkout', '-b', 'agentos/run-1');
  for (const [path, content] of Object.entries(files)) {
    const target = join(repository, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await git('add', '.');
  // --allow-empty: one case publishes no files, and an empty delivered commit
  // is still a published branch.
  await git('commit', '--allow-empty', '-m', 'delivered');
  await git('checkout', 'main');
  return { repository, branch: 'agentos/run-1' };
}

afterEach(async () => {
  for (const runId of startedRunIds.splice(0)) await stopRunPreview(runId);
  await Promise.all(
    repositories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function start(input: {
  runId: string;
  repository: string;
  branch: string;
}) {
  startedRunIds.push(input.runId);
  return startRunPreview(input);
}

describe('isRunPreviewAvailable', () => {
  it('is refused in production regardless of the public URL', () => {
    expect(
      isRunPreviewAvailable({
        NODE_ENV: 'production',
        AGENTOS_PUBLIC_URL: 'http://localhost:3000',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('is refused when the deployment is not on localhost', () => {
    expect(
      isRunPreviewAvailable({
        NODE_ENV: 'development',
        AGENTOS_PUBLIC_URL: 'https://agentos.example.com',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('is allowed for a localhost development deployment', () => {
    expect(
      isRunPreviewAvailable({
        NODE_ENV: 'development',
        AGENTOS_PUBLIC_URL: 'http://localhost:3000',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe('startRunPreview', () => {
  it('checks the branch out without moving it or touching the working tree', async () => {
    const { repository, branch } = await publishedRepository({
      'src/greet.mjs': 'export const greet = () => "hi";\n',
    });
    const preview = await start({ runId: 'run-1', repository, branch });

    expect(preview.status).toBe('no_server');
    expect(preview.worktree).toContain('agentos-preview-');
    // The delivered file is there...
    const { stdout: files } = await run('ls', [join(preview.worktree, 'src')]);
    expect(files).toContain('greet.mjs');
    // ...and the repository is still on main, with the branch where it was.
    const { stdout: head } = await run('git', [
      '-C',
      repository,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    expect(head.trim()).toBe('main');
  });

  it('explains itself when the project declares no server script', async () => {
    const { repository, branch } = await publishedRepository({
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { test: 'node --test' },
      }),
    });
    const preview = await start({ runId: 'run-2', repository, branch });
    expect(preview.status).toBe('no_server');
    expect(preview.url).toBeUndefined();
    // The checkout survives, so the hint's path is one the operator can use.
    expect(preview.hint).toContain(preview.worktree);
    expect(preview.hint).toMatch(/no dev or start script/i);
  });

  it('returns the running preview instead of starting a second copy', async () => {
    const { repository, branch } = await publishedRepository({
      'package.json': JSON.stringify({ name: 'x' }),
    });
    const first = await start({ runId: 'run-3', repository, branch });
    const second = await startRunPreview({
      runId: 'run-3',
      repository,
      branch,
    });
    expect(second.worktree).toBe(first.worktree);
    expect(listRunPreviews().filter((p) => p.runId === 'run-3')).toHaveLength(
      1,
    );
  });

  it('refuses a branch that does not exist, leaving nothing behind', async () => {
    const { repository } = await publishedRepository({});
    await expect(
      startRunPreview({
        runId: 'run-4',
        repository,
        branch: 'agentos/never-published',
      }),
    ).rejects.toMatchObject({ code: 'preview_checkout_failed', status: 503 });
    expect(getRunPreview('run-4')).toBeUndefined();
    const { stdout } = await run('git', ['-C', repository, 'worktree', 'list']);
    // Only the repository itself: a refused checkout registers no worktree.
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });
});

describe('stopRunPreview', () => {
  it('removes the checkout and forgets the preview', async () => {
    const { repository, branch } = await publishedRepository({
      'package.json': JSON.stringify({ name: 'x' }),
    });
    const preview = await start({ runId: 'run-5', repository, branch });
    await stopRunPreview('run-5');
    expect(getRunPreview('run-5')).toBeUndefined();
    const { stdout } = await run('git', ['-C', repository, 'worktree', 'list']);
    expect(stdout).not.toContain(preview.worktree);
  });

  it('is safe to call for a run with no preview', async () => {
    await expect(stopRunPreview('run-never')).resolves.toBeUndefined();
  });
});
