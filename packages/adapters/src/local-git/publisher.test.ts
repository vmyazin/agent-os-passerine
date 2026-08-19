import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalPublicationManifestDigest,
  canonicalPublicationPolicyDigest,
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  DEFAULT_PUBLICATION_POLICY,
  type PublicationAuthorizationClaims,
  type PublicationManifestBody,
} from '@agentos/core';

import { InMemoryPublicationStore } from '../github/store.js';
import { createLocalGitPublisher } from './publisher.js';
import { cleanupFixtures, fixtureRoot, seedRepo } from './test-support.js';

const exec = promisify(execFile);

const POLICY_DIGEST = canonicalPublicationPolicyDigest(
  DEFAULT_PUBLICATION_POLICY,
);
const key = {
  keyId: 'local-publisher-2026-08',
  secret: 'local-publisher-authorization-secret-32b',
} as const;
const issuer = createHmacAttestationIssuer<PublicationAuthorizationClaims>({
  ...key,
  kind: 'github-publication',
});
const verifier = createHmacAttestationVerifier<PublicationAuthorizationClaims>({
  kind: 'github-publication',
  keys: [key],
});
const NOW = () => new Date('2026-08-17T12:00:00.000Z');

afterEach(async () => {
  await cleanupFixtures();
});

/** Raw system-git helper for test setup/assertions -- deliberately not
 * routed through the production `runGit` plumbing runner, which only
 * allowlists the narrow set of subcommands the publisher itself needs. */
async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args]);
  return stdout.trim();
}

/** Seeds a repo (via test-support's `seedRepo`) and then extends it with a
 * nested directory shape (`src/a.txt`, `src/lib/b.txt`, `top.txt`) so
 * happy-path tests can exercise add/modify/delete across directory
 * levels. */
async function seedNestedRepo(root: string, name: string): Promise<string> {
  const repo = await seedRepo(root, name);
  await mkdir(join(repo, 'src'));
  await mkdir(join(repo, 'src', 'lib'));
  await writeFile(join(repo, 'src', 'a.txt'), 'a content\n');
  await writeFile(join(repo, 'src', 'lib', 'b.txt'), 'b content\n');
  await writeFile(join(repo, 'top.txt'), 'top content\n');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'seed nested files']);
  return repo;
}

function manifestBody(
  repo: string,
  base: string,
  overrides: Partial<PublicationManifestBody> = {},
): PublicationManifestBody {
  return {
    version: 'publication-manifest-v1',
    projectId: 'project-1',
    runId: 'run-1',
    stepId: 'publish-1',
    repository: { kind: 'local', owner: 'local', name: basename(repo) },
    expectedBase: { branch: 'main', sha: base },
    configDigest: 'a'.repeat(64),
    policyDigest: POLICY_DIGEST,
    sourceSnapshotDigest: 'b'.repeat(64),
    testEvidence: [{ kind: 'test-report', artifactDigest: 'c'.repeat(64) }],
    changes: [
      {
        operation: 'add',
        path: 'src/new/nested.txt',
        mode: '100644',
        content: 'new content\n',
      },
      {
        operation: 'modify',
        path: 'src/a.txt',
        mode: '100644',
        content: 'a content changed\n',
      },
      { operation: 'delete', path: 'top.txt' },
    ],
    ...overrides,
  };
}

function authorize(
  manifest: PublicationManifestBody,
  claimOverrides: Partial<PublicationAuthorizationClaims> = {},
) {
  const manifestDigest = canonicalPublicationManifestDigest(manifest);
  return issuer.issue({
    subject: `${manifest.projectId}:${manifest.runId}:${manifestDigest}`,
    issuedAt: '2026-08-17T11:59:00.000Z',
    claims: {
      purpose: 'publish-draft-pr',
      audience: 'local-git-publisher',
      projectId: manifest.projectId,
      runId: manifest.runId,
      stepId: manifest.stepId,
      repository: manifest.repository,
      expectedBase: manifest.expectedBase,
      configDigest: manifest.configDigest,
      policyDigest: manifest.policyDigest,
      sourceSnapshotDigest: manifest.sourceSnapshotDigest,
      testEvidenceDigest: canonicalPublicationManifestDigest(
        manifest.testEvidence,
      ),
      manifestDigest,
      nonce: 'local-nonce-1',
      expiresAt: '2026-08-17T12:05:00.000Z',
      ...claimOverrides,
    },
  });
}

async function fixture() {
  const root = await fixtureRoot();
  const repo = await seedNestedRepo(root, 'exp-repo');
  const base = await git(repo, ['rev-parse', 'HEAD']);
  const store = new InMemoryPublicationStore();
  const publisher = createLocalGitPublisher({
    workspacesRoot: root,
    localPath: repo,
    verifier,
    store,
    now: NOW,
  });
  return { root, repo, base, store, publisher };
}

describe('local git publisher', () => {
  it('publishes add+modify+delete as a plumbing commit without touching the working tree', async () => {
    const { repo, base, publisher } = await fixture();
    const manifest = manifestBody(repo, base);
    const digest = canonicalPublicationManifestDigest(manifest);
    const statusBefore = await git(repo, ['status', '--porcelain']);
    const headBefore = await git(repo, ['rev-parse', 'HEAD']);

    const result = await publisher.publish({
      manifest,
      authorization: authorize(manifest),
    });

    expect(result).toEqual({
      status: 'succeeded',
      local: true,
      branch: `agentos/run-1-${digest.slice(0, 8)}`,
      commitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      repositoryUrl: `file://${repo}`,
    });

    const branchSha = await git(repo, [
      'rev-parse',
      `refs/heads/${result.branch}`,
    ]);
    expect(branchSha).toBe(result.commitSha);

    const parentSha = await git(repo, ['rev-parse', `${result.commitSha}^`]);
    expect(parentSha).toBe(base);

    const tree = await git(repo, ['ls-tree', '-r', result.commitSha]);
    const paths = tree
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split('\t')[1]);
    expect(paths.sort()).toEqual(
      ['file.txt', 'src/a.txt', 'src/lib/b.txt', 'src/new/nested.txt'].sort(),
    );

    const statusAfter = await git(repo, ['status', '--porcelain']);
    expect(statusAfter).toBe(statusBefore);
    expect(statusAfter).toBe('');

    const headAfter = await git(repo, ['rev-parse', 'HEAD']);
    expect(headAfter).toBe(headBefore);
  });

  it('preserves an executable mode on a modified file', async () => {
    const { repo, base, publisher } = await fixture();
    const manifest = manifestBody(repo, base, {
      changes: [
        {
          operation: 'modify',
          path: 'src/a.txt',
          mode: '100755',
          content: 'a content changed\n',
        },
      ],
    });

    const result = await publisher.publish({
      manifest,
      authorization: authorize(manifest),
    });

    const tree = await git(repo, ['ls-tree', '-r', result.commitSha]);
    const line = tree.split('\n').find((entry) => entry.endsWith('\tsrc/a.txt'));
    expect(line?.startsWith('100755 blob')).toBe(true);
  });

  it('rejects a github-audience token', async () => {
    const { repo, base, publisher } = await fixture();
    const manifest = manifestBody(repo, base);
    const authorization = authorize(manifest, { audience: 'github-publisher' });

    await expect(
      publisher.publish({ manifest, authorization }),
    ).rejects.toThrow('Publication authorization is invalid or expired');
  });

  it('rejects when the base branch head moved past expectedBase', async () => {
    const { repo, base, publisher } = await fixture();
    const manifest = manifestBody(repo, base);
    const authorization = authorize(manifest);
    await exec('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'drift']);

    await expect(
      publisher.publish({ manifest, authorization }),
    ).rejects.toThrow('Publication base changed');
  });

  it('rejects a change touching a protected path', async () => {
    const { repo, base, publisher } = await fixture();
    const manifest = manifestBody(repo, base, {
      changes: [
        {
          operation: 'add',
          path: '.github/workflows/x.yml',
          mode: '100644',
          content: 'name: x\n',
        },
      ],
    });
    const authorization = authorize(manifest);

    // `publish()` mirrors the GitHub publisher's structure: it parses the
    // manifest synchronously (see local-git/publisher.ts) before entering
    // the async dedup/execute path, so a manifest-level rejection (like a
    // protected path) throws synchronously rather than yielding a rejected
    // promise. Wrapping in an async closure normalizes both cases.
    await expect(
      (async () => publisher.publish({ manifest, authorization }))(),
    ).rejects.toThrow(/protected/i);
  });

  it('rejects a manifest whose repository identity is GitHub, not local', async () => {
    const { repo, base, publisher } = await fixture();
    const manifest = manifestBody(repo, base, {
      repository: {
        owner: 'team-zork',
        name: 'passerine',
        installationId: 42,
        repositoryId: 314159,
      },
    });
    const authorization = authorize(manifest);

    // Same synchronous-throw consideration as the protected-path test above:
    // the repository-kind guard runs inside `publish()`'s synchronous key
    // computation.
    await expect(
      (async () => publisher.publish({ manifest, authorization }))(),
    ).rejects.toThrow(
      'GitHub publications must use the trusted GitHub publisher',
    );
  });

  it('replays idempotently without creating a second commit', async () => {
    const { repo, base, publisher } = await fixture();
    const manifest = manifestBody(repo, base);
    const authorization = authorize(manifest);

    const first = await publisher.publish({ manifest, authorization });
    const countAfterFirst = await git(repo, [
      'rev-list',
      '--count',
      first.branch,
    ]);

    const second = await publisher.publish({ manifest, authorization });
    expect(second).toEqual(first);

    const countAfterSecond = await git(repo, [
      'rev-list',
      '--count',
      first.branch,
    ]);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('rejects when the target branch ref already exists', async () => {
    const { repo, base, publisher } = await fixture();
    const manifest = manifestBody(repo, base);
    const authorization = authorize(manifest);
    const digest = canonicalPublicationManifestDigest(manifest);
    const branch = `agentos/run-1-${digest.slice(0, 8)}`;
    await exec('git', ['-C', repo, 'branch', branch, 'HEAD']);

    await expect(
      publisher.publish({ manifest, authorization }),
    ).rejects.toThrow('Publication branch already exists');
  });
});
