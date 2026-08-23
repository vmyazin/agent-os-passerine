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

import { GitHubPublisherError } from '../github/errors.js';
import {
  createPostgresPublicationStoreForTest,
  type PublicationSqlExecutor,
} from '../github/postgres-store.js';
import { InMemoryPublicationStore } from '../github/store.js';
import type { PublicationPhase, PublicationStore } from '../github/types.js';
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

async function fixture(store: PublicationStore = new InMemoryPublicationStore()) {
  const root = await fixtureRoot();
  const repo = await seedNestedRepo(root, 'exp-repo');
  const base = await git(repo, ['rev-parse', 'HEAD']);
  const publisher = createLocalGitPublisher({
    workspacesRoot: root,
    localPath: repo,
    verifier,
    store,
    now: NOW,
  });
  return { root, repo, base, store, publisher };
}

/** Captures the exact input passed to `store.claim`, delegating everything
 * else to a real `InMemoryPublicationStore` so the publisher's full
 * behavior is otherwise unaffected. */
class CapturingStore implements PublicationStore {
  claimedInput: Parameters<PublicationStore['claim']>[0] | undefined;
  readonly #inner = new InMemoryPublicationStore();

  async claim(
    input: Parameters<PublicationStore['claim']>[0],
  ): ReturnType<PublicationStore['claim']> {
    this.claimedInput = input;
    return this.#inner.claim(input);
  }

  async save(
    ...args: Parameters<PublicationStore['save']>
  ): ReturnType<PublicationStore['save']> {
    return this.#inner.save(...args);
  }

  async get(key: string): ReturnType<PublicationStore['get']> {
    return this.#inner.get(key);
  }

  async listEvents(): ReturnType<PublicationStore['listEvents']> {
    return this.#inner.listEvents();
  }
}

describe('local git publisher', () => {
  it('stacks a chained publication on the previous run\'s branch', async () => {
    const { repo, base, publisher } = await fixture();

    // Run A publishes off the default branch, as an unchained run does.
    const first = manifestBody(repo, base, {
      runId: 'run-1',
      changes: [
        {
          operation: 'add',
          path: 'src/first.txt',
          mode: '100644',
          content: 'first feature\n',
        },
      ],
    });
    const a = await publisher.publish({
      manifest: first,
      authorization: authorize(first),
    });
    expect(a.status).toBe('succeeded');

    // Run B chains: its expectedBase is A's branch and commit, which is
    // exactly what the workflow builds for a run with a chain edge.
    const second = manifestBody(repo, base, {
      runId: 'run-2',
      expectedBase: { branch: a.branch, sha: a.commitSha },
      changes: [
        {
          operation: 'add',
          path: 'src/second.txt',
          mode: '100644',
          content: 'second feature\n',
        },
      ],
    });
    const b = await publisher.publish({
      manifest: second,
      authorization: authorize(second),
    });

    expect(await git(repo, ['rev-parse', `${b.commitSha}^`])).toBe(
      a.commitSha,
    );
    // The stack accumulates: B's tree carries A's file as well as its own,
    // so merging B's branch takes both features.
    const tree = await git(repo, ['ls-tree', '-r', '--name-only', b.commitSha]);
    expect(tree.split('\n')).toEqual(
      expect.arrayContaining(['src/first.txt', 'src/second.txt']),
    );
    // And the default branch is untouched until the operator merges.
    expect(await git(repo, ['rev-parse', 'main'])).toBe(base);
  });

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

  it('rejects a manifest signed with a policyDigest that does not match the resolved policy', async () => {
    const { repo, base, publisher } = await fixture();
    const manifest = manifestBody(repo, base, {
      policyDigest: 'f'.repeat(64),
    });
    const authorization = authorize(manifest);

    await expect(
      (async () => publisher.publish({ manifest, authorization }))(),
    ).rejects.toThrow('publication policy digest mismatch');
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

  describe('durable store compatibility (repositoryId sentinel)', () => {
    it('claims local records with a positive repositoryId sentinel, not 0', async () => {
      // The durable Postgres store's `publication_records` table enforces
      // `repository_id > 0` and its row-mapping layer independently rejects
      // any non-positive value -- `repositoryId: 0` would make every local
      // publication unusable against that store.
      const store = new CapturingStore();
      const { repo, base, publisher } = await fixture(store);
      const manifest = manifestBody(repo, base);

      await publisher.publish({ manifest, authorization: authorize(manifest) });

      expect(store.claimedInput?.repositoryId).toBe(1);
    });

    it('claims and saves a local publication record through PostgresPublicationStore', async () => {
      // Exercises the same TypeScript row-mapping/validation layer the
      // durable store uses (`mapRecord`/`safeInteger` in
      // packages/adapters/src/github/postgres-store.ts) against a
      // local-shaped record (repositoryId: 1), via the executor-mocking
      // test harness that already exists for it (see
      // packages/adapters/src/github/postgres-store.test.ts) -- no real
      // database is required, so this isn't gated behind TEST_DATABASE_URL.
      const rows = new Map<string, Record<string, unknown>>();
      const execute: PublicationSqlExecutor['execute'] = async (sql, params) => {
        if (sql.includes('agentos_claim_publication')) {
          const [
            recordKey,
            bindingKey,
            projectId,
            runId,
            repositoryId,
            manifestDigest,
            policyDigest,
            baseSha,
            branch,
            now,
          ] = params as [
            string,
            string,
            string,
            string,
            number,
            string,
            string,
            string,
            string,
            string,
          ];
          const row = {
            key: recordKey,
            bindingKey,
            projectId,
            runId,
            repositoryId: String(repositoryId),
            manifestDigest,
            policyDigest,
            baseSha,
            branch,
            phase: 'claimed',
            blobShas: null,
            treeSha: null,
            commitSha: null,
            pullRequestNumber: null,
            pullRequestUrl: null,
            draft: null,
            errorCode: null,
            revision: '1',
            createdAt: now,
            updatedAt: now,
          };
          rows.set(recordKey, row);
          return [row];
        }
        throw new Error(`unexpected SQL in test: ${sql}`);
      };
      const store = createPostgresPublicationStoreForTest({ execute });

      const record = await store.claim({
        key: 'local-publication-key',
        bindingKey: 'local-binding-key',
        projectId: 'project-1',
        runId: 'run-1',
        repositoryId: 1,
        manifestDigest: 'a'.repeat(64),
        policyDigest: 'b'.repeat(64),
        baseSha: 'c'.repeat(40),
        branch: 'agentos/run-1-12345678',
        now: '2026-08-17T12:00:00.000Z',
      });

      expect(record).toMatchObject({
        repositoryId: 1,
        phase: 'claimed',
        revision: 1,
      });
    });
  });

  describe('tree-shape collisions against the base tree', () => {
    it('rejects adding a blob where the base tree still has files under that path', async () => {
      const { repo, base, publisher } = await fixture();
      // Base tree has src/a.txt and src/lib/b.txt -- adding a blob at
      // 'src' would make 'src' both a blob and (via the still-present
      // 'src/a.txt') a directory in the same tree.
      const manifest = manifestBody(repo, base, {
        changes: [
          { operation: 'add', path: 'src', mode: '100644', content: 'oops\n' },
        ],
      });

      await expect(
        publisher.publish({ manifest, authorization: authorize(manifest) }),
      ).rejects.toThrow(/collides with existing tree shape/);
    });

    it('rejects adding a blob under a path that is already a file', async () => {
      const { repo, base, publisher } = await fixture();
      // Base tree has file.txt as a blob -- adding 'file.txt/evil.txt'
      // would require 'file.txt' to simultaneously be a blob and a
      // directory.
      const manifest = manifestBody(repo, base, {
        changes: [
          {
            operation: 'add',
            path: 'file.txt/evil.txt',
            mode: '100644',
            content: 'oops\n',
          },
        ],
      });

      await expect(
        publisher.publish({ manifest, authorization: authorize(manifest) }),
      ).rejects.toThrow(/collides with existing tree shape/);
    });

    it('allows replacing a directory with a blob when every file under it is deleted in the same change set', async () => {
      const { repo, base, publisher } = await fixture();
      // Delete every file under src/ first, then add a blob at 'src' --
      // legal, since nothing remains under that prefix once the deletes
      // are applied.
      const manifest = manifestBody(repo, base, {
        changes: [
          { operation: 'delete', path: 'src/a.txt' },
          { operation: 'delete', path: 'src/lib/b.txt' },
          { operation: 'add', path: 'src', mode: '100644', content: 'now a file\n' },
        ],
      });

      const result = await publisher.publish({
        manifest,
        authorization: authorize(manifest),
      });

      const tree = await git(repo, ['ls-tree', '-r', result.commitSha]);
      const paths = tree
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.split('\t')[1]);
      expect(paths.sort()).toEqual(['file.txt', 'src', 'top.txt'].sort());

      // The resulting tree must be structurally sound -- no duplicate or
      // overlapping entries anywhere reachable from refs.
      const fsck = await exec('git', ['-C', repo, 'fsck', '--full', '--strict']);
      expect(fsck.stdout.trim()).toBe('');
      expect(fsck.stderr.trim()).toBe('');
    });
  });

  describe('resuming a crashed publish from its recorded phase', () => {
    /** Wraps a real `PublicationStore` and throws once, synchronously
     * before delegating, the first time `save` is asked to persist a given
     * phase -- simulating a transient failure (e.g. a database blip)
     * between two checkpoints of an otherwise-successful publish. */
    class FailingOnceStore implements PublicationStore {
      #failOnPhase: PublicationPhase | undefined;
      constructor(
        private readonly inner: PublicationStore,
        failOnPhase: PublicationPhase,
      ) {
        this.#failOnPhase = failOnPhase;
      }
      async claim(
        input: Parameters<PublicationStore['claim']>[0],
      ): ReturnType<PublicationStore['claim']> {
        return this.inner.claim(input);
      }
      async save(
        ...args: Parameters<PublicationStore['save']>
      ): ReturnType<PublicationStore['save']> {
        const [, , patch] = args;
        if (this.#failOnPhase !== undefined && patch.phase === this.#failOnPhase) {
          this.#failOnPhase = undefined;
          throw new Error('transient database failure');
        }
        return this.inner.save(...args);
      }
      async get(key: string): ReturnType<PublicationStore['get']> {
        return this.inner.get(key);
      }
      async listEvents(): ReturnType<PublicationStore['listEvents']> {
        return this.inner.listEvents();
      }
    }

    async function recordFor(store: PublicationStore) {
      const events = await store.listEvents();
      const key = events[0]?.publicationKey;
      expect(key).toBeDefined();
      return store.get(key!);
    }

    it('resumes after a crash between the update-ref call and its ref_created checkpoint', async () => {
      // The git branch/commit gets created successfully (update-ref runs
      // fine), but persisting the ref_created checkpoint fails -- the
      // durable record is left at 'commit_created'. A naive retry that
      // treats "the ref already exists" as an automatic collision would be
      // stuck here forever, since the checkpoint can never advance.
      const inner = new InMemoryPublicationStore();
      const root = await fixtureRoot();
      const repo = await seedNestedRepo(root, 'exp-repo');
      const base = await git(repo, ['rev-parse', 'HEAD']);
      const manifest = manifestBody(repo, base);
      const authorization = authorize(manifest);

      const crashingStore = new FailingOnceStore(inner, 'ref_created');
      const publisher1 = createLocalGitPublisher({
        workspacesRoot: root,
        localPath: repo,
        verifier,
        store: crashingStore,
        now: NOW,
      });
      await expect(
        publisher1.publish({ manifest, authorization }),
      ).rejects.toThrow('transient database failure');

      const recordAfterCrash = await recordFor(inner);
      expect(recordAfterCrash?.phase).toBe('commit_created');
      // The branch really was created by the crashed attempt.
      await expect(
        git(repo, ['rev-parse', `refs/heads/agentos/run-1-${canonicalPublicationManifestDigest(manifest).slice(0, 8)}`]),
      ).resolves.toMatch(/^[0-9a-f]{40}$/);

      // A fresh publisher instance, sharing the same underlying store,
      // resumes and succeeds.
      const publisher2 = createLocalGitPublisher({
        workspacesRoot: root,
        localPath: repo,
        verifier,
        store: inner,
        now: NOW,
      });
      const result = await publisher2.publish({ manifest, authorization });

      expect(result.status).toBe('succeeded');
      const branchSha = await git(repo, [
        'rev-parse',
        `refs/heads/${result.branch}`,
      ]);
      expect(branchSha).toBe(result.commitSha);

      const commitsOnTopOfBase = await git(repo, [
        'rev-list',
        '--count',
        result.branch,
        `^${base}`,
      ]);
      expect(commitsOnTopOfBase).toBe('1');

      const finalRecord = await recordFor(inner);
      // `ref_created`, not `succeeded`: this publisher's durable terminal
      // phase (see the `LOCAL_PHASE_ORDER` comment in publisher.ts for
      // why `pr_created`/`succeeded` are never attempted against the real
      // schema -- a CHECK constraint makes both unreachable for a
      // non-GitHub publication).
      expect(finalRecord?.phase).toBe('ref_created');
      expect(finalRecord?.commitSha).toBe(result.commitSha);
    });

    it('resuming from an already-durable ref_created record replays without touching git', async () => {
      // Once a record reaches this publisher's terminal phase
      // (`ref_created`), a later `publish()` call for the same manifest --
      // even a brand new publisher instance -- must short-circuit to
      // success without running any git command at all (mirrors the
      // top-level replay test, but exercised specifically through the
      // resume path after a prior crash-and-recover, not a clean run).
      const inner = new InMemoryPublicationStore();
      const root = await fixtureRoot();
      const repo = await seedNestedRepo(root, 'exp-repo');
      const base = await git(repo, ['rev-parse', 'HEAD']);
      const manifest = manifestBody(repo, base);
      const authorization = authorize(manifest);

      const publisher1 = createLocalGitPublisher({
        workspacesRoot: root,
        localPath: repo,
        verifier,
        store: inner,
        now: NOW,
      });
      const first = await publisher1.publish({ manifest, authorization });
      expect((await recordFor(inner))?.phase).toBe('ref_created');

      const publisher2 = createLocalGitPublisher({
        workspacesRoot: root,
        localPath: repo,
        verifier,
        store: inner,
        now: NOW,
      });
      const second = await publisher2.publish({ manifest, authorization });

      expect(second).toEqual(first);
      const commitsOnTopOfBase = await git(repo, [
        'rev-list',
        '--count',
        first.branch,
        `^${base}`,
      ]);
      expect(commitsOnTopOfBase).toBe('1');
    });
  });

  describe('reconciling a durable-store save conflict', () => {
    /** Wraps a real `PublicationStore`. The first time `save` is asked to
     * persist `conflictOnPhase`, it applies that *exact* patch to the
     * underlying store first (simulating a concurrent attempt that raced
     * ahead and won), then reports a conflict to the caller -- exactly
     * what real optimistic-concurrency contention looks like: the
     * checkpoint really did advance, just not via *this* call. */
    class ConcurrentWinnerStore implements PublicationStore {
      #conflictOnPhase: PublicationPhase | undefined;
      constructor(
        private readonly inner: PublicationStore,
        conflictOnPhase: PublicationPhase,
      ) {
        this.#conflictOnPhase = conflictOnPhase;
      }
      async claim(
        input: Parameters<PublicationStore['claim']>[0],
      ): ReturnType<PublicationStore['claim']> {
        return this.inner.claim(input);
      }
      async save(
        ...args: Parameters<PublicationStore['save']>
      ): ReturnType<PublicationStore['save']> {
        const [key, expectedRevision, patch, publicationEvent] = args;
        if (
          this.#conflictOnPhase !== undefined &&
          patch.phase === this.#conflictOnPhase
        ) {
          this.#conflictOnPhase = undefined;
          await this.inner.save(
            key,
            expectedRevision,
            patch,
            publicationEvent,
          );
          throw new GitHubPublisherError(
            'publication_store_conflict',
            'Publication checkpoint changed concurrently',
          );
        }
        return this.inner.save(...args);
      }
      async get(key: string): ReturnType<PublicationStore['get']> {
        return this.inner.get(key);
      }
      async listEvents(): ReturnType<PublicationStore['listEvents']> {
        return this.inner.listEvents();
      }
    }

    it('reconciles a save conflict after update-ref succeeds instead of failing the run', async () => {
      const inner = new InMemoryPublicationStore();
      const store = new ConcurrentWinnerStore(inner, 'ref_created');
      const root = await fixtureRoot();
      const repo = await seedNestedRepo(root, 'exp-repo');
      const base = await git(repo, ['rev-parse', 'HEAD']);
      const manifest = manifestBody(repo, base);
      const authorization = authorize(manifest);

      const publisher = createLocalGitPublisher({
        workspacesRoot: root,
        localPath: repo,
        verifier,
        store,
        now: NOW,
      });

      // A checkpoint race after the branch commit already exists must
      // never strand the run: this single `publish()` call must succeed,
      // not throw -- the conflict is reconciled inline, with no need for
      // the caller to retry.
      const result = await publisher.publish({ manifest, authorization });

      expect(result.status).toBe('succeeded');
      const branchSha = await git(repo, [
        'rev-parse',
        `refs/heads/${result.branch}`,
      ]);
      expect(branchSha).toBe(result.commitSha);
      const commitsOnTopOfBase = await git(repo, [
        'rev-list',
        '--count',
        result.branch,
        `^${base}`,
      ]);
      expect(commitsOnTopOfBase).toBe('1');
    });

    it('still fails on a save conflict whose durable state does not match (genuine conflict)', async () => {
      // A conflict is only reconciled when durable state AND the git ref
      // agree the publication already reached this phase with the *same*
      // commit. Here `ref_created` always reports a conflict but --
      // unlike `ConcurrentWinnerStore` above -- never actually applies
      // that patch anywhere, so the durable record stays behind at
      // `commit_created` forever: reconciliation must correctly refuse to
      // paper over this and the conflict must still propagate.
      class NeverResolvingConflictStore implements PublicationStore {
        constructor(
          private readonly inner: PublicationStore,
          private readonly conflictOnPhase: PublicationPhase,
        ) {}
        async claim(
          input: Parameters<PublicationStore['claim']>[0],
        ): ReturnType<PublicationStore['claim']> {
          return this.inner.claim(input);
        }
        async save(
          ...args: Parameters<PublicationStore['save']>
        ): ReturnType<PublicationStore['save']> {
          const [, , patch] = args;
          if (patch.phase === this.conflictOnPhase) {
            throw new GitHubPublisherError(
              'publication_store_conflict',
              'Publication checkpoint changed concurrently',
            );
          }
          return this.inner.save(...args);
        }
        async get(k: string): ReturnType<PublicationStore['get']> {
          return this.inner.get(k);
        }
        async listEvents(): ReturnType<PublicationStore['listEvents']> {
          return this.inner.listEvents();
        }
      }

      const inner = new InMemoryPublicationStore();
      const store = new NeverResolvingConflictStore(inner, 'ref_created');
      const root = await fixtureRoot();
      const repo = await seedNestedRepo(root, 'exp-repo');
      const base = await git(repo, ['rev-parse', 'HEAD']);
      const manifest = manifestBody(repo, base);
      const authorization = authorize(manifest);

      const publisher = createLocalGitPublisher({
        workspacesRoot: root,
        localPath: repo,
        verifier,
        store,
        now: NOW,
      });

      await expect(
        publisher.publish({ manifest, authorization }),
      ).rejects.toThrow('Publication checkpoint changed concurrently');
    });
  });
});
