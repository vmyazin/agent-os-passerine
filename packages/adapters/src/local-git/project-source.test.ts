import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isoTimestamp, persistenceId } from '@agentos/core';
import { describe, expect, it } from 'vitest';

import {
  inspectLocalProjectSource,
  listLocalProjectCommits,
} from './project-source.js';

const execute = promisify(execFile);

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-C', directory, ...args], {
    encoding: 'utf8',
  });
  return result.stdout.trimEnd();
}

async function repository(name = 'sample'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentos-source-'));
  const path = join(root, name);
  await mkdir(path);
  await git(path, 'init', '-b', 'main');
  await git(path, 'config', 'user.name', 'Renée Developer');
  await git(path, 'config', 'user.email', 'renee@example.test');
  await git(path, 'commit', '--allow-empty', '-m', 'Initial café commit');
  return path;
}

describe('local project sources', () => {
  it('resolves symlinks and inspects only the exact non-bare working-tree top level', async () => {
    const path = await repository('passerine');
    const alias = `${path}-alias`;
    await symlink(path, alias);

    const inspected = await inspectLocalProjectSource({ localPath: alias });
    expect(inspected).toMatchObject({
      kind: 'local',
      canonicalLocation: await realpath(path),
      suggestedName: 'passerine',
      defaultBranch: 'main',
      sourceKey: `local:${await realpath(path)}`,
    });
    expect(inspected.headSha).toMatch(/^[0-9a-f]{40}$/);

    const child = join(path, 'child');
    await mkdir(child);
    await expect(
      inspectLocalProjectSource({ localPath: child }),
    ).rejects.toMatchObject({
      code: 'not_top_level',
    });

    const bare = join(
      await mkdtemp(join(tmpdir(), 'agentos-bare-')),
      'bare.git',
    );
    await execute('git', ['init', '--bare', bare]);
    await expect(
      inspectLocalProjectSource({ localPath: bare }),
    ).rejects.toMatchObject({
      code: 'not_a_repository',
    });
  });

  it('uses a confirmed branch override and falls back to origin/HEAD when detached', async () => {
    const path = await repository();
    await git(path, 'branch', 'release');
    await expect(
      inspectLocalProjectSource({ localPath: path, defaultBranch: 'release' }),
    ).resolves.toMatchObject({ defaultBranch: 'release' });
    await expect(
      inspectLocalProjectSource({ localPath: path, defaultBranch: 'missing' }),
    ).rejects.toMatchObject({
      code: 'unavailable_branch',
    });

    await git(path, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(
      path,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    );
    await git(path, 'checkout', '--detach');
    await expect(
      inspectLocalProjectSource({ localPath: path }),
    ).resolves.toMatchObject({
      defaultBranch: 'main',
    });
  });

  it('returns validated 25-commit pages with an opaque bounded cursor', async () => {
    const path = await repository();
    for (let index = 1; index <= 26; index += 1)
      await git(
        path,
        'commit',
        '--allow-empty',
        '-m',
        `Unicode change ${String(index)} — ✓`,
      );
    const source = {
      kind: 'local' as const,
      projectId: persistenceId('project', 'local-commit-source'),
      sourceKey: `local:${await realpath(path)}`,
      localPath: await realpath(path),
      defaultBranch: 'main',
      createdAt: isoTimestamp('2026-08-24T12:00:00.000Z'),
      updatedAt: isoTimestamp('2026-08-24T12:00:00.000Z'),
    };

    const first = await listLocalProjectCommits(source);
    expect(first.items).toHaveLength(25);
    expect(first.items[0]).toMatchObject({
      subject: 'Unicode change 26 — ✓',
      authorName: 'Renée Developer',
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listLocalProjectCommits(source, first.nextCursor);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();

    await expect(
      listLocalProjectCommits(source, 'not-a-cursor'),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(
      listLocalProjectCommits(source, 'x'.repeat(2_049)),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
});
