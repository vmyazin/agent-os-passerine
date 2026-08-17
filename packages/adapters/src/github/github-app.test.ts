import { describe, expect, it, vi } from 'vitest';

import {
  createGitHubAppClientFactory,
  createGitHubAppClientFactoryForTest,
} from './github-app.js';
import type { InstallationClientScope } from './types.js';

const scope: InstallationClientScope = {
  owner: 'team-zork',
  name: 'passerine',
  installationId: 42,
  repositoryId: 314159,
  repositoryIds: [314159],
  permissions: { contents: 'write', pullRequests: 'write' },
};

function authResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'token',
    tokenType: 'installation',
    token: 'x',
    installationId: 42,
    createdAt: '2026-08-17T11:59:00.000Z',
    expiresAt: '2026-08-17T12:59:00.000Z',
    permissions: { contents: 'write', pull_requests: 'write' },
    repositorySelection: 'selected',
    repositoryIds: [314159],
    ...overrides,
  };
}

describe('GitHub App installation client factory', () => {
  it('mints one opaque repository-scoped token with only required effective permissions', async () => {
    const auth = vi.fn(async () => authResult());
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          'https://api.github.com/repos/team-zork/passerine',
        );
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer x',
        );
        return Response.json({
          id: 314159,
          full_name: 'team-zork/passerine',
          default_branch: 'main',
        });
      },
    );
    const factory = createGitHubAppClientFactoryForTest({
      auth,
      fetch,
      now: () => new Date('2026-08-17T12:00:00.000Z'),
    });

    await expect(
      factory.withClient(scope, (client) => client.getRepository()),
    ).resolves.toEqual({
      id: 314159,
      fullName: 'team-zork/passerine',
      defaultBranch: 'main',
    });
    expect(auth).toHaveBeenCalledExactlyOnceWith({
      type: 'installation',
      installationId: 42,
      repositoryIds: [314159],
      permissions: { contents: 'write', pull_requests: 'write' },
      refresh: true,
    });
  });

  it.each([
    { repositoryIds: [999] },
    { installationId: 999 },
    { permissions: { contents: 'read', pull_requests: 'write' } },
    { permissions: { contents: 'write', pull_requests: 'read' } },
    {
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        metadata: 'write',
      },
    },
    { repositorySelection: 'all' },
    { token: '' },
    { expiresAt: '2026-08-17T11:00:00.000Z' },
  ])(
    'rejects a token whose effective scope is broader or weaker: %o',
    async (override) => {
      const auth = vi.fn(async () => authResult(override));
      const fetch = vi.fn();
      const factory = createGitHubAppClientFactoryForTest({
        auth,
        fetch,
        now: () => new Date('2026-08-17T12:00:00.000Z'),
      });
      await expect(
        factory.withClient(scope, async () => 'never'),
      ).rejects.toMatchObject({
        code: 'github_unavailable',
        message: 'GitHub App installation authentication failed',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('validates the app configuration and permits only official HTTPS GitHub API', () => {
    expect(() =>
      createGitHubAppClientFactory({ appId: 0, privateKey: 'not-a-key' }),
    ).toThrow(/app id/i);
    expect(() =>
      createGitHubAppClientFactory({ appId: 1, privateKey: 'not-a-key' }),
    ).toThrow(/private key/i);
    expect(() =>
      createGitHubAppClientFactory({
        appId: 1,
        privateKey:
          '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        apiBaseUrl: 'https://github.example.test/api/v3',
      }),
    ).toThrow(/api\.github\.com/i);
  });

  it('uses bounded response parsing and redacts tokens and hostile error bodies', async () => {
    const auth = vi.fn(async () => authResult({ token: 'ghs_NEVER_EXPOSE' }));
    const fetch = vi.fn(
      async () =>
        new Response('hostile ghs_NEVER_EXPOSE body'.repeat(100_000), {
          status: 500,
        }),
    );
    const factory = createGitHubAppClientFactoryForTest({
      auth,
      fetch,
      now: () => new Date('2026-08-17T12:00:00.000Z'),
    });
    await expect(
      factory.withClient(scope, (client) => client.getRepository()),
    ).rejects.toMatchObject({
      code: 'github_unavailable',
      message: 'GitHub API request failed',
    });
  });

  it('fails closed on malformed API responses and never exposes a generic request surface', async () => {
    const auth = vi.fn(async () => authResult());
    const fetch = vi.fn(async () => Response.json({ id: 'wrong' }));
    const factory = createGitHubAppClientFactoryForTest({
      auth,
      fetch,
      now: () => new Date('2026-08-17T12:00:00.000Z'),
    });
    await expect(
      factory.withClient(scope, async (client) => {
        expect('request' in client).toBe(false);
        expect('merge' in client).toBe(false);
        expect('updateReference' in client).toBe(false);
        return client.getRepository();
      }),
    ).rejects.toMatchObject({ code: 'github_unavailable' });
  });

  it('rejects mismatched Git object identities and PRs without immutable repository IDs', async () => {
    const expected = 'a'.repeat(40);
    const commitFactory = createGitHubAppClientFactoryForTest({
      auth: vi.fn(async () => authResult()),
      fetch: vi.fn(async () =>
        Response.json({
          sha: 'b'.repeat(40),
          tree: { sha: 'c'.repeat(40) },
          message: 'foreign',
          parents: [],
        }),
      ),
      now: () => new Date('2026-08-17T12:00:00.000Z'),
    });
    await expect(
      commitFactory.withClient(scope, (client) => client.getCommit(expected)),
    ).rejects.toMatchObject({ code: 'github_unavailable' });

    const treeFactory = createGitHubAppClientFactoryForTest({
      auth: vi.fn(async () => authResult()),
      fetch: vi.fn(async () =>
        Response.json({ sha: 'b'.repeat(40), tree: [], truncated: false }),
      ),
      now: () => new Date('2026-08-17T12:00:00.000Z'),
    });
    await expect(
      treeFactory.withClient(scope, (client) => client.getTree(expected)),
    ).rejects.toMatchObject({ code: 'github_unavailable' });

    const prFactory = createGitHubAppClientFactoryForTest({
      auth: vi.fn(async () => authResult()),
      fetch: vi.fn(async () =>
        Response.json([
          {
            number: 7,
            html_url: 'https://github.com/team-zork/passerine/pull/7',
            draft: true,
            body: 'copied marker',
            head: { ref: 'agentos/run' },
            base: { ref: 'main' },
          },
        ]),
      ),
      now: () => new Date('2026-08-17T12:00:00.000Z'),
    });
    await expect(
      prFactory.withClient(scope, (client) =>
        client.listOpenPullRequests({ head: 'agentos/run', base: 'main' }),
      ),
    ).rejects.toMatchObject({ code: 'github_unavailable' });
  });

  it('parses only an open draft PR with immutable repository IDs and head SHA', async () => {
    const headSha = 'a'.repeat(40);
    const factory = createGitHubAppClientFactoryForTest({
      auth: vi.fn(async () => authResult()),
      fetch: vi.fn(async () =>
        Response.json([
          {
            number: 7,
            html_url: 'https://github.com/team-zork/passerine/pull/7',
            draft: true,
            state: 'open',
            title: 'Agent OS: run-1',
            body: 'trusted body',
            head: {
              ref: 'agentos/run-1',
              sha: headSha,
              repo: { id: 314159 },
            },
            base: { ref: 'main', repo: { id: 314159 } },
          },
        ]),
      ),
      now: () => new Date('2026-08-17T12:00:00.000Z'),
    });
    await expect(
      factory.withClient(scope, (client) =>
        client.listOpenPullRequests({ head: 'agentos/run-1', base: 'main' }),
      ),
    ).resolves.toEqual([
      {
        number: 7,
        url: 'https://github.com/team-zork/passerine/pull/7',
        draft: true,
        state: 'open',
        title: 'Agent OS: run-1',
        body: 'trusted body',
        head: 'agentos/run-1',
        headSha,
        base: 'main',
        headRepositoryId: 314159,
        baseRepositoryId: 314159,
      },
    ]);
  });
});
