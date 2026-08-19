import type { GitHubPublicationRepository } from '@agentos/core';

import { createGitHubReadOnlyClientFactory } from './github-app.js';
import type { GitHubReadOnlyClientFactory } from './types.js';

export interface TrustedRepositoryHeadResolver {
  resolve(input: {
    readonly repository: GitHubPublicationRepository;
    readonly repositoryUrl: string;
    readonly defaultBranch: string;
  }): Promise<string>;
}

/** Resolve one selected repository head with a contents-read-only token. */
export function createTrustedRepositoryHeadResolver(options: {
  readonly githubApp: { readonly appId: number; readonly privateKey: string };
}): TrustedRepositoryHeadResolver {
  return createTrustedRepositoryHeadResolverWithClientFactory(
    createGitHubReadOnlyClientFactory(options.githubApp),
  );
}

export function createTrustedRepositoryHeadResolverWithClientFactory(
  github: GitHubReadOnlyClientFactory,
): TrustedRepositoryHeadResolver {
  return Object.freeze({
    async resolve(
      input: Parameters<TrustedRepositoryHeadResolver['resolve']>[0],
    ) {
      const configured = new URL(input.repositoryUrl);
      const path = configured.pathname.replace(/^\//, '').replace(/\.git$/, '');
      if (
        configured.protocol !== 'https:' ||
        configured.hostname !== 'github.com' ||
        path !== `${input.repository.owner}/${input.repository.name}`
      )
        throw new Error(
          'configuration repository is outside the selected GitHub repository',
        );
      return github.withClient(
        {
          ...input.repository,
          repositoryIds: [input.repository.repositoryId],
          permissions: { contents: 'read' },
        },
        async (client) => {
          const repository = await client.getRepository();
          if (
            repository.id !== input.repository.repositoryId ||
            repository.fullName !==
              `${input.repository.owner}/${input.repository.name}`
          )
            throw new Error('selected GitHub repository binding mismatch');
          const reference = await client.getReference(input.defaultBranch);
          if (reference === undefined)
            throw new Error('selected GitHub default branch is unavailable');
          return reference.sha;
        },
      );
    },
  });
}
