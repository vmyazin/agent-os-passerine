// packages/adapters/src/github/repository-allowlist.test.ts
import { describe, expect, it } from 'vitest';

import {
  assertReaderPublisherRepositoryPairing,
  githubOwnerNameFromUrl,
  githubRepositoryBindingKey,
  parseGitHubRepositoryAllowlist,
  selectGitHubRepositoryFromUrl,
} from './repository-allowlist.js';

const sandbox = {
  owner: 'team-zork',
  name: 'sandbox',
  installationId: 1,
  repositoryId: 2,
} as const;

const other = {
  owner: 'team-zork',
  name: 'other',
  installationId: 3,
  repositoryId: 4,
} as const;

describe('GitHub repository allowlist', () => {
  it('parses and keys repository bindings', () => {
    const allowlist = parseGitHubRepositoryAllowlist(
      JSON.stringify([sandbox, other]),
      'GITHUB_SELECTED_REPOSITORIES_JSON',
    );
    expect(allowlist).toHaveLength(2);
    expect(githubRepositoryBindingKey(sandbox)).toBe('team-zork/sandbox');
  });

  it('requires reader and publisher allowlists to match pairwise', () => {
    expect(() =>
      assertReaderPublisherRepositoryPairing([sandbox], [other]),
    ).toThrow(/reader and publisher/i);
    expect(() =>
      assertReaderPublisherRepositoryPairing(
        [sandbox, other],
        [sandbox, { ...other, repositoryId: 99 }],
      ),
    ).toThrow(/reader and publisher/i);
    expect(() =>
      assertReaderPublisherRepositoryPairing([sandbox, other], [sandbox, other]),
    ).not.toThrow();
  });

  it('pairs the same repository across separate reader and publisher Apps', () => {
    // The reader and the publisher are deliberately distinct GitHub Apps, so
    // each has its own installation on the same repository. Pairing must key
    // on repository identity (owner/name/repositoryId); comparing
    // installationId would reject every real deployment.
    const publisherSandbox = { ...sandbox, installationId: 99 } as const;
    expect(() =>
      assertReaderPublisherRepositoryPairing([sandbox], [publisherSandbox]),
    ).not.toThrow();

    // A genuinely different repository still fails, even when the two
    // allowlists happen to share an installationId.
    expect(() =>
      assertReaderPublisherRepositoryPairing(
        [sandbox],
        [{ ...other, installationId: sandbox.installationId }],
      ),
    ).toThrow(/reader and publisher/i);
  });

  it('selects a configured repository URL against the allowlist', () => {
    expect(
      selectGitHubRepositoryFromUrl(
        'https://github.com/team-zork/sandbox.git',
        [sandbox, other],
      ),
    ).toEqual(sandbox);
    expect(() =>
      selectGitHubRepositoryFromUrl(
        'https://github.com/team-zork/unlisted.git',
        [sandbox, other],
      ),
    ).toThrow(/allowlist/i);
  });

  it('parses github.com owner/name URLs', () => {
    expect(
      githubOwnerNameFromUrl('https://github.com/team-zork/sandbox'),
    ).toEqual({ owner: 'team-zork', name: 'sandbox' });
    expect(() =>
      githubOwnerNameFromUrl('https://gitlab.com/team-zork/sandbox'),
    ).toThrow(/github.com/i);
  });
});
