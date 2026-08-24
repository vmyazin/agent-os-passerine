import { isoTimestamp, persistenceId } from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { createGitHubProjectSourceReaderForTest } from './project-source.js';

const future = '2030-01-01T00:00:00.000Z';

function installationToken(installationId = 77, repositoryId = 123) {
  return {
    type: 'token',
    tokenType: 'installation',
    token: 'installation-token',
    installationId,
    repositorySelection: 'selected',
    repositoryIds: [repositoryId],
    permissions: { contents: 'read', metadata: 'read' },
    expiresAt: future,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHub project sources', () => {
  it('accepts only canonical repository URLs and inspects with exact read scope', async () => {
    const readerAuth = vi.fn(
      async (input: Readonly<Record<string, unknown>>) =>
        input.type === 'app'
          ? { type: 'app', token: 'reader-app-token' }
          : installationToken(),
    );
    const publisherAuth = vi.fn(async () => ({
      type: 'app',
      token: 'publisher-app-token',
    }));
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/installation')) return json({ id: 77 });
        if (request.url.endsWith('/repos/acme/passerine'))
          return json({
            id: 123,
            name: 'passerine',
            full_name: 'acme/passerine',
            html_url: 'https://github.com/acme/passerine',
            default_branch: 'main',
          });
        if (request.url.endsWith('/commits/main'))
          return json({ sha: 'a'.repeat(40) });
        throw new Error(`unexpected ${request.url}`);
      },
    );
    const reader = createGitHubProjectSourceReaderForTest({
      readerAuth,
      publisherAuth,
      fetch,
      now: () => new Date('2026-08-24T00:00:00.000Z'),
    });

    await expect(
      reader.inspect('https://github.com/acme/passerine'),
    ).resolves.toEqual({
      inspection: {
        kind: 'github',
        sourceKey: 'github:acme/passerine',
        canonicalLocation: 'https://github.com/acme/passerine',
        suggestedName: 'passerine',
        defaultBranch: 'main',
        headSha: 'a'.repeat(40),
        publisherReady: true,
      },
      repositoryId: 123,
      readerInstallationId: 77,
      publisherInstallationId: 77,
    });
    expect(readerAuth).toHaveBeenCalledWith({ type: 'app' });
    expect(readerAuth).toHaveBeenCalledWith({
      type: 'installation',
      installationId: 77,
      repositoryNames: ['passerine'],
      permissions: { contents: 'read' },
      refresh: true,
    });
    expect(
      fetch.mock.calls.some(([input, init]) =>
        new Request(
          input as string | URL | Request,
          init as RequestInit,
        ).headers
          .get('authorization')
          ?.includes('installation-token'),
      ),
    ).toBe(true);

    for (const invalid of [
      'http://github.com/acme/passerine',
      'https://github.com/acme/passerine/',
      'https://github.com/acme/passerine.git',
      'https://github.com/acme/passerine/issues',
    ])
      await expect(reader.inspect(invalid)).rejects.toMatchObject({
        code: 'invalid_repository_url',
      });
  });

  it('reports missing reader installation while publisher discovery stays non-blocking', async () => {
    const missing = createGitHubProjectSourceReaderForTest({
      readerAuth: async () => ({ type: 'app', token: 'reader-app-token' }),
      fetch: async () => json({ message: 'Not Found' }, 404),
    });
    await expect(
      missing.inspect('https://github.com/acme/passerine'),
    ).rejects.toMatchObject({
      code: 'missing_reader_installation',
    });

    const reader = createGitHubProjectSourceReaderForTest({
      readerAuth: async (input) =>
        input.type === 'app'
          ? { type: 'app', token: 'reader-app-token' }
          : installationToken(),
      publisherAuth: async () => {
        throw new Error('publisher offline');
      },
      fetch: async (input) => {
        const url = new Request(input).url;
        if (url.endsWith('/installation')) return json({ id: 77 });
        if (url.endsWith('/repos/acme/passerine'))
          return json({
            id: 123,
            name: 'passerine',
            full_name: 'acme/passerine',
            html_url: 'https://github.com/acme/passerine',
            default_branch: 'main',
          });
        return json({ sha: 'b'.repeat(40) });
      },
    });
    const inspected = await reader.inspect('https://github.com/acme/passerine');
    expect(inspected).toMatchObject({ inspection: { publisherReady: false } });
    expect(inspected.publisherInstallationId).toBeUndefined();
  });

  it('pages and validates default-branch commits', async () => {
    const commits = Array.from({ length: 25 }, (_, index) => ({
      sha: index.toString(16).padStart(40, '0'),
      html_url: `https://github.com/acme/passerine/commit/${index.toString(16).padStart(40, '0')}`,
      commit: {
        message: index === 0 ? '' : `Change ${String(index)}\n\nBody`,
        author: {
          name: index === 0 ? '' : 'Zoë Maintainer',
          date: '2026-08-24T12:00:00Z',
        },
        committer: { date: '2026-08-24T12:00:00Z' },
      },
    }));
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new Request(input).url;
      if (url.includes('/commits?')) return json(commits);
      throw new Error(`unexpected ${url}`);
    });
    const reader = createGitHubProjectSourceReaderForTest({
      readerAuth: async () => installationToken(),
      fetch,
      now: () => new Date('2026-08-24T00:00:00.000Z'),
    });
    const source = {
      kind: 'github' as const,
      projectId: persistenceId('project', 'github-source'),
      sourceKey: 'github:acme/passerine',
      repositoryUrl: 'https://github.com/acme/passerine',
      owner: 'acme',
      name: 'passerine',
      repositoryId: 123,
      readerInstallationId: 77,
      defaultBranch: 'main',
      createdAt: isoTimestamp('2026-08-24T12:00:00.000Z'),
      updatedAt: isoTimestamp('2026-08-24T12:00:00.000Z'),
    };

    const first = await reader.listCommits(source);
    expect(first.items).toHaveLength(25);
    expect(first.items[0]).toMatchObject({
      subject: '',
      authorName: 'Unknown author',
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(fetch.mock.calls[0]?.[0].toString()).toContain('per_page=25');
    expect(fetch.mock.calls[0]?.[0].toString()).toContain('page=1');
    await reader.listCommits(source, first.nextCursor);
    expect(fetch.mock.calls[1]?.[0].toString()).toContain('page=2');
    await expect(
      reader.listCommits(source, 'x'.repeat(2_049)),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });

    const malformed = createGitHubProjectSourceReaderForTest({
      readerAuth: async () => installationToken(),
      fetch: async () => json([{ sha: 'unsafe' }]),
    });
    await expect(malformed.listCommits(source)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });
});
