import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const roots: string[] = [];

/**
 * Creates a fresh temp directory tracked for cleanup and returns its
 * realpath, so containment assertions in tests compare like-for-like paths.
 */
export async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentos-localgit-'));
  roots.push(root);
  return realpath(root);
}

/**
 * Seeds a real git repository (via system git, not the plumbing runner)
 * inside `root`, for use as a fixture in local-git tests.
 */
export async function seedRepo(root: string, name: string): Promise<string> {
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

/** Removes every root created by {@link fixtureRoot} since the last cleanup. */
export async function cleanupFixtures(): Promise<void> {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}
