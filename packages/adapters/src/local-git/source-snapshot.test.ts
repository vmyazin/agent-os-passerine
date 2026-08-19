import { execFile } from 'node:child_process';
import { chmod, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
import { LocalGitError } from './git.js';
import {
  createLocalSourceSnapshotIngestor,
  type LocalSourceSnapshotBinding,
} from './source-snapshot.js';
import { cleanupFixtures, fixtureRoot, seedRepo } from './test-support.js';

const exec = promisify(execFile);

afterEach(async () => {
  await cleanupFixtures();
});

function ingestorFor(
  root: string,
  bindings: Record<string, Omit<LocalSourceSnapshotBinding, 'runId'>>,
) {
  const artifacts = createInMemoryArtifactStorage().store;
  const ingestor = createLocalSourceSnapshotIngestor({
    artifacts,
    workspacesRoot: root,
    resolveBinding: async (runId) => {
      const binding = bindings[runId];
      if (binding === undefined) throw new Error(`no binding for ${runId}`);
      return { ...binding, runId };
    },
  });
  return { artifacts, ingestor };
}

describe('local source snapshot ingestion', () => {
  it('writes a source-bundle-v1 artifact that round-trips repository content', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    await writeFile(join(repo, 'script.sh'), '#!/bin/sh\necho hi\n');
    await chmod(join(repo, 'script.sh'), 0o755);
    await exec('git', ['-C', repo, 'add', 'script.sh']);
    await exec('git', ['-C', repo, 'commit', '-m', 'add script']);

    const headSha = (
      await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const expectedTreeSha = (
      await exec('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}'])
    ).stdout.trim();

    const { artifacts, ingestor } = ingestorFor(root, {
      'run-1': {
        projectId: 'project-1',
        localPath: repo,
        baseBranch: 'main',
        repositorySha: headSha,
      },
    });

    const metadata = await ingestor.ensure('run-1');
    const value = await artifacts.get({
      scope: { projectId: 'project-1', runId: 'run-1', stepId: 'source' },
      key: metadata.key,
    });
    expect(value).toBeDefined();
    const body = JSON.parse(new TextDecoder().decode(value!.bytes)) as {
      version: string;
      repository: { kind: string; owner: string; name: string };
      baseBranch: string;
      repositorySha: string;
      treeSha: string;
      files: Array<{ path: string; mode: string; content: string }>;
    };

    expect(body.version).toBe('source-bundle-v1');
    expect(body.repository).toEqual({
      kind: 'local',
      owner: 'local',
      name: 'exp',
    });
    expect(body.baseBranch).toBe('main');
    expect(body.repositorySha).toBe(headSha);
    expect(body.treeSha).toBe(expectedTreeSha);
    // `runGit` trimEnd()s stdout, so a file's trailing newline is not
    // preserved through this ingestor -- see the caveat documented next to
    // the `cat-file blob` call in source-snapshot.ts.
    expect(body.files).toEqual([
      { path: 'file.txt', mode: '100644', content: 'hello' },
      {
        path: 'script.sh',
        mode: '100755',
        content: '#!/bin/sh\necho hi',
      },
    ]);
  });

  it('rejects a binding pinned to a nonexistent SHA', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const { ingestor } = ingestorFor(root, {
      'run-1': {
        projectId: 'project-1',
        localPath: repo,
        baseBranch: 'main',
        repositorySha: 'a'.repeat(40),
      },
    });
    await expect(ingestor.ensure('run-1')).rejects.toThrow();
  });

  it('rejects a tree containing a symlink', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    await symlink('file.txt', join(repo, 'link'));
    await exec('git', ['-C', repo, 'add', 'link']);
    await exec('git', ['-C', repo, 'commit', '-m', 'add symlink']);
    const headSha = (
      await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])
    ).stdout.trim();

    const { ingestor } = ingestorFor(root, {
      'run-1': {
        projectId: 'project-1',
        localPath: repo,
        baseBranch: 'main',
        repositorySha: headSha,
      },
    });
    await expect(ingestor.ensure('run-1')).rejects.toThrow(
      /symlink|submodule/,
    );
  });

  it('rejects a file containing a NUL byte', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    await writeFile(
      join(repo, 'bin.dat'),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    );
    await exec('git', ['-C', repo, 'add', 'bin.dat']);
    await exec('git', ['-C', repo, 'commit', '-m', 'add binary']);
    const headSha = (
      await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])
    ).stdout.trim();

    const { ingestor } = ingestorFor(root, {
      'run-1': {
        projectId: 'project-1',
        localPath: repo,
        baseBranch: 'main',
        repositorySha: headSha,
      },
    });
    await expect(ingestor.ensure('run-1')).rejects.toThrow(/binary/);
  });

  it('is idempotent across repeated ensure calls', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const headSha = (
      await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const { ingestor } = ingestorFor(root, {
      'run-1': {
        projectId: 'project-1',
        localPath: repo,
        baseBranch: 'main',
        repositorySha: headSha,
      },
    });
    const first = await ingestor.ensure('run-1');
    const second = await ingestor.ensure('run-1');
    expect(second).toEqual(first);
    expect(second.digest).toBe(first.digest);
    expect(second.key).toBe(first.key);
  });

  it('rejects a binding whose localPath is outside the workspaces root', async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    const repo = await seedRepo(outside, 'escapee');
    const headSha = (
      await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const { ingestor } = ingestorFor(root, {
      'run-1': {
        projectId: 'project-1',
        localPath: repo,
        baseBranch: 'main',
        repositorySha: headSha,
      },
    });
    await expect(ingestor.ensure('run-1')).rejects.toThrow(LocalGitError);
  });
});
