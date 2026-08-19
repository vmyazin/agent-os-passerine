import { execFile } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  initializeLocalRepository,
  LocalRepositoryAlreadyExistsError,
} from './initialize.js';
import { cleanupFixtures, fixtureRoot } from './test-support.js';

const exec = promisify(execFile);

afterEach(async () => {
  await cleanupFixtures();
});

describe('initializeLocalRepository', () => {
  it('creates a seeded repository with one commit and a 40-hex HEAD', async () => {
    const root = await fixtureRoot();
    const result = await initializeLocalRepository({
      workspacesRoot: root,
      name: 'exp-one',
    });

    expect(result.localPath).toBe(join(root, 'exp-one'));
    expect(result.branch).toBe('main');
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/);

    const gitDir = await stat(join(result.localPath, '.git'));
    expect(gitDir.isDirectory()).toBe(true);

    const packageJsonRaw = await readFile(
      join(result.localPath, 'package.json'),
      'utf8',
    );
    const packageJson = JSON.parse(packageJsonRaw) as Record<string, unknown>;
    expect(packageJson.name).toBe('exp-one');
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe('module');
    expect(packageJson.scripts).toEqual({ test: 'node --test' });
    expect(packageJson.packageManager).toBeUndefined();

    const smokeTest = await stat(
      join(result.localPath, 'test', 'smoke.test.mjs'),
    );
    expect(smokeTest.isFile()).toBe(true);

    const { stdout: commitCount } = await exec('git', [
      '-C',
      result.localPath,
      'rev-list',
      '--count',
      'HEAD',
    ]);
    expect(commitCount.trim()).toBe('1');

    const { stdout: commitLog } = await exec('git', [
      '-C',
      result.localPath,
      'log',
      '-1',
      '--pretty=%an <%ae>%n%s',
    ]);
    expect(commitLog.trim()).toBe(
      'Agent OS Setup <agentos@localhost>\nInitialize experiment repository',
    );

    const { stdout: branch } = await exec('git', [
      '-C',
      result.localPath,
      'branch',
      '--show-current',
    ]);
    expect(branch.trim()).toBe('main');
  });

  it('includes the packageManager line when given', async () => {
    const root = await fixtureRoot();
    const result = await initializeLocalRepository({
      workspacesRoot: root,
      name: 'exp-two',
      packageManagerLine: 'pnpm@11.12.0',
    });
    const packageJsonRaw = await readFile(
      join(result.localPath, 'package.json'),
      'utf8',
    );
    const packageJson = JSON.parse(packageJsonRaw) as Record<string, unknown>;
    expect(packageJson.packageManager).toBe('pnpm@11.12.0');
  });

  it('rejects an already-existing directory with a distinguishable error', async () => {
    const root = await fixtureRoot();
    await initializeLocalRepository({ workspacesRoot: root, name: 'exp-dup' });
    await expect(
      initializeLocalRepository({ workspacesRoot: root, name: 'exp-dup' }),
    ).rejects.toBeInstanceOf(LocalRepositoryAlreadyExistsError);
  });

  it('rejects names outside the allowed pattern', async () => {
    const root = await fixtureRoot();
    await expect(
      initializeLocalRepository({ workspacesRoot: root, name: '..' }),
    ).rejects.toThrow(/repository name/);
    await expect(
      initializeLocalRepository({ workspacesRoot: root, name: 'UPPER' }),
    ).rejects.toThrow(/repository name/);
  });

  it('removes the directory it created if initialization fails partway through', async () => {
    const root = await fixtureRoot();
    // Force every `git` invocation after the (already-succeeded) `mkdir`
    // to fail deterministically by making the `git` binary unresolvable,
    // without touching the target directory itself -- a reliable trigger
    // for "mkdir succeeded, then a later step failed" that doesn't depend
    // on filesystem permission quirks.
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent-agentos-test-path';
    try {
      await expect(
        initializeLocalRepository({ workspacesRoot: root, name: 'exp-fail' }),
      ).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
    }

    await expect(stat(join(root, 'exp-fail'))).rejects.toThrow();
  });
});
