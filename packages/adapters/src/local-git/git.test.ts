import { mkdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertContainedRepository, LocalGitError, runGit } from './git.js';
import { cleanupFixtures, fixtureRoot, seedRepo } from './test-support.js';

afterEach(async () => {
  await cleanupFixtures();
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
