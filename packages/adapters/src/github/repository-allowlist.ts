// packages/adapters/src/github/repository-allowlist.ts
import {
  githubRepositorySchema,
  type GitHubPublicationRepository,
} from '@agentos/core';
import { z } from 'zod';

const githubRepositoryAllowlistSchema = z
  .array(githubRepositorySchema)
  .min(1, 'at least one GitHub repository binding is required');

export function githubRepositoryBindingKey(
  repository: Pick<GitHubPublicationRepository, 'owner' | 'name'>,
): string {
  return `${repository.owner}/${repository.name}`;
}

export function parseGitHubRepositoryAllowlist(
  raw: string,
  environmentVariable: string,
): readonly GitHubPublicationRepository[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${environmentVariable} must contain valid JSON`);
  }
  const result = githubRepositoryAllowlistSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(`${environmentVariable} must list valid repository bindings`);
  return result.data;
}

export function githubOwnerNameFromUrl(repositoryUrl: string): {
  readonly owner: string;
  readonly name: string;
} {
  const configured = new URL(repositoryUrl);
  const path = configured.pathname.replace(/^\//, '').replace(/\.git$/, '');
  if (
    configured.protocol !== 'https:' ||
    configured.hostname !== 'github.com' ||
    !/^[^/]+\/[^/]+$/.test(path)
  )
    throw new Error('GitHub repository URL must name an github.com owner/repo');
  const [owner, name] = path.split('/');
  return { owner: owner!, name: name! };
}

/**
 * Repository identity, deliberately excluding `installationId`. The reader and
 * the publisher are separate GitHub Apps, so each holds its own installation on
 * the same repository and their installation IDs differ by construction.
 * Comparing them here would reject every correctly configured deployment.
 */
export function sameRepositoryIdentity(
  left: GitHubPublicationRepository,
  right: GitHubPublicationRepository,
): boolean {
  return (
    left.owner === right.owner &&
    left.name === right.name &&
    left.repositoryId === right.repositoryId
  );
}

/** Reader and publisher allowlists must cover the same repository set. */
export function assertReaderPublisherRepositoryPairing(
  readerRepositories: readonly GitHubPublicationRepository[],
  publisherRepositories: readonly GitHubPublicationRepository[],
): void {
  for (const publisher of publisherRepositories) {
    const reader = readerRepositories.find((candidate) =>
      sameRepositoryIdentity(candidate, publisher),
    );
    if (reader === undefined)
      throw new Error(
        `reader and publisher GitHub Apps must bind the same repositories (${githubRepositoryBindingKey(publisher)} is missing from the reader allowlist)`,
      );
  }
  for (const reader of readerRepositories) {
    const publisher = publisherRepositories.find((candidate) =>
      sameRepositoryIdentity(candidate, reader),
    );
    if (publisher === undefined)
      throw new Error(
        `reader and publisher GitHub Apps must bind the same repositories (${githubRepositoryBindingKey(reader)} is missing from the publisher allowlist)`,
      );
  }
}

export function selectGitHubRepositoryFromUrl(
  repositoryUrl: string,
  allowlist: readonly GitHubPublicationRepository[],
): GitHubPublicationRepository {
  const { owner, name } = githubOwnerNameFromUrl(repositoryUrl);
  const matches = allowlist.filter(
    (candidate) => candidate.owner === owner && candidate.name === name,
  );
  if (matches.length !== 1)
    throw new Error(
      'configuration repository is outside the deployment GitHub repository allowlist',
    );
  return matches[0]!;
}

export function listGitHubRepositoryBindings(
  raw: string | undefined,
): readonly string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return parseGitHubRepositoryAllowlist(raw, 'GITHUB_SELECTED_REPOSITORIES_JSON').map(
      githubRepositoryBindingKey,
    );
  } catch {
    return undefined;
  }
}
