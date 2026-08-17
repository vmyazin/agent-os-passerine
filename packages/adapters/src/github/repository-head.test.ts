import { describe, expect, it, vi } from 'vitest';

import { createTrustedRepositoryHeadResolverWithClientFactory } from './repository-head.js';
import type {
  GitHubReadOnlyClientFactory,
  ReadOnlyInstallationClientScope,
} from './types.js';

const SHA = 'a'.repeat(40);

describe('trusted repository head resolver', () => {
  it('resolves the selected default branch through an exact contents-read scope', async () => {
    const scopes: ReadOnlyInstallationClientScope[] = [];
    const withClient: GitHubReadOnlyClientFactory['withClient'] = async (
      scope,
      operation,
    ) => {
      scopes.push(scope);
      return operation({
        getRepository: async () => ({
          id: 42,
          fullName: 'team/repo',
          defaultBranch: 'main',
        }),
        getReference: async () => ({ sha: SHA }),
        getCommit: vi.fn(),
        getTree: vi.fn(),
        getBlob: vi.fn(),
      });
    };
    const resolver = createTrustedRepositoryHeadResolverWithClientFactory({
      withClient,
    });

    await expect(
      resolver.resolve({
        repository: {
          owner: 'team',
          name: 'repo',
          installationId: 7,
          repositoryId: 42,
        },
        repositoryUrl: 'https://github.com/team/repo.git',
        defaultBranch: 'main',
      }),
    ).resolves.toBe(SHA);
    expect(scopes[0]).toEqual({
      owner: 'team',
      name: 'repo',
      installationId: 7,
      repositoryId: 42,
      repositoryIds: [42],
      permissions: { contents: 'read' },
    });
  });

  it('rejects a configured repository outside the selected installation', async () => {
    let calls = 0;
    const withClient: GitHubReadOnlyClientFactory['withClient'] = async () => {
      calls += 1;
      throw new Error('must not create a client');
    };
    const resolver = createTrustedRepositoryHeadResolverWithClientFactory({
      withClient,
    });
    await expect(
      resolver.resolve({
        repository: {
          owner: 'team',
          name: 'repo',
          installationId: 7,
          repositoryId: 42,
        },
        repositoryUrl: 'https://github.com/team/other',
        defaultBranch: 'main',
      }),
    ).rejects.toThrow('outside the selected GitHub repository');
    expect(calls).toBe(0);
  });
});
