import { mkdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertContainedRepository,
  LocalGitError,
  parseGitBlobBatch,
  readGitBlobs,
  runGit,
} from './git.js';
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

describe('runGit argument validation', () => {
  it('rejects hash-object with a path argument instead of --stdin', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    await expect(
      runGit(repo, ['hash-object', '-w', '/etc/passwd']),
    ).rejects.toThrow(LocalGitError);
  });

  it('rejects hash-object missing the required --stdin flag', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    await expect(runGit(repo, ['hash-object', '-w'])).rejects.toThrow(
      LocalGitError,
    );
  });

  it('rejects ls-tree with an unknown flag', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    await expect(
      runGit(repo, ['ls-tree', '--stdin-paths', 'HEAD']),
    ).rejects.toThrow(LocalGitError);
  });

  it('allows cat-file -t to report an object type', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const head = await runGit(repo, ['rev-parse', 'HEAD']);
    await expect(runGit(repo, ['cat-file', '-t', head])).resolves.toBe(
      'commit',
    );
  });

  it('the raw option preserves trailing bytes that the default trims', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const blob = await runGit(repo, ['hash-object', '-w', '--stdin'], {
      input: 'trailing newline\n\n',
    });
    await expect(runGit(repo, ['cat-file', 'blob', blob])).resolves.toBe(
      'trailing newline',
    );
    await expect(
      runGit(repo, ['cat-file', 'blob', blob], { raw: true }),
    ).resolves.toBe('trailing newline\n\n');
  });

  it('rejects commit-tree with -F to read a message from a file', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const tree = await runGit(repo, ['rev-parse', 'HEAD^{tree}']);
    await expect(
      runGit(repo, ['commit-tree', tree, '-F', '/etc/passwd']),
    ).rejects.toThrow(LocalGitError);
  });

  it('allows the legitimate plumbing flows used by later tasks', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');

    const blob = await runGit(repo, ['hash-object', '-w', '--stdin'], {
      input: 'hello world\n',
    });
    expect(blob).toMatch(/^[0-9a-f]{40}$/);

    const tree = await runGit(repo, ['mktree', '-z'], {
      input: `100644 blob ${blob}\tfile.txt\0`,
    });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);

    const parent = await runGit(repo, ['rev-parse', 'HEAD']);
    const commit = await runGit(repo, [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      'test commit',
    ]);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    await runGit(repo, ['update-ref', 'refs/heads/x', commit, '']);
    await expect(
      runGit(repo, ['rev-parse', 'refs/heads/x']),
    ).resolves.toBe(commit);
  });
});

describe('readGitBlobs', () => {
  it('reads multiple blobs byte-exactly in one batch', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const first = await runGit(repo, ['rev-parse', 'HEAD:file.txt']);
    const second = await runGit(repo, ['hash-object', '-w', '--stdin'], {
      input: 'second blob\n\n',
    });

    const blobs = await readGitBlobs(repo, [first, second]);

    expect(blobs.map((blob) => new TextDecoder().decode(blob))).toEqual([
      'hello\n',
      'second blob\n\n',
    ]);
  });

  it.each([
    ['malformed header', Buffer.from('not-a-header\n')],
    [
      'mismatched object',
      Buffer.from(`${'b'.repeat(40)} blob 1\nx\n`),
    ],
    [
      'wrong object type',
      Buffer.from(`${'a'.repeat(40)} tree 1\nx\n`),
    ],
    [
      'truncated body',
      Buffer.from(`${'a'.repeat(40)} blob 2\nx\n`),
    ],
    [
      'invalid delimiter',
      Buffer.from(`${'a'.repeat(40)} blob 1\nxx`),
    ],
    [
      'trailing output',
      Buffer.from(`${'a'.repeat(40)} blob 1\nx\nextra`),
    ],
  ])('rejects %s', (_label, output) => {
    expect(() => parseGitBlobBatch(output, ['a'.repeat(40)])).toThrow(
      /batch output/,
    );
  });
});

describe('runGit env injection', () => {
  it('stamps a deterministic author/committer identity from the allowed env keys', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const tree = await runGit(repo, ['rev-parse', 'HEAD^{tree}']);
    const parent = await runGit(repo, ['rev-parse', 'HEAD']);
    const commit = await runGit(
      repo,
      ['commit-tree', tree, '-p', parent, '-m', 'identity test'],
      {
        env: {
          GIT_AUTHOR_NAME: 'Agent OS Publisher',
          GIT_AUTHOR_EMAIL: 'agentos@localhost',
          GIT_COMMITTER_NAME: 'Agent OS Publisher',
          GIT_COMMITTER_EMAIL: 'agentos@localhost',
        },
      },
    );
    const shown = await runGit(repo, ['cat-file', '-p', commit]);
    expect(shown).toContain('author Agent OS Publisher <agentos@localhost>');
    expect(
      shown,
    ).toContain('committer Agent OS Publisher <agentos@localhost>');
  });

  it('rejects environment variables outside the allowlist', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    await expect(
      runGit(repo, ['rev-parse', 'HEAD'], {
        env: { GIT_SSH_COMMAND: 'evil' },
      }),
    ).rejects.toThrow(LocalGitError);
  });

  it('fixes the author/committer date, making commit-tree content-addressed across retries', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const tree = await runGit(repo, ['rev-parse', 'HEAD^{tree}']);
    const parent = await runGit(repo, ['rev-parse', 'HEAD']);
    const env = {
      GIT_AUTHOR_NAME: 'Agent OS Publisher',
      GIT_AUTHOR_EMAIL: 'agentos@localhost',
      GIT_AUTHOR_DATE: '2026-08-17T11:59:00.000Z',
      GIT_COMMITTER_NAME: 'Agent OS Publisher',
      GIT_COMMITTER_EMAIL: 'agentos@localhost',
      GIT_COMMITTER_DATE: '2026-08-17T11:59:00.000Z',
    };
    const first = await runGit(
      repo,
      ['commit-tree', tree, '-p', parent, '-m', 'deterministic test'],
      { env },
    );
    const second = await runGit(
      repo,
      ['commit-tree', tree, '-p', parent, '-m', 'deterministic test'],
      { env },
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
  });
});
