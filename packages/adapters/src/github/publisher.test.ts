import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalPublicationPolicyDigest,
  canonicalPublicationManifestDigest,
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  DEFAULT_PUBLICATION_POLICY,
  type PublicationAuthorizationClaims,
  type PublicationManifestBody,
} from '@agentos/core';

import { GitHubPublisherError } from './errors.js';
import { createTrustedGitHubPublisher } from './publisher.js';
import { InMemoryPublicationStore } from './store.js';
import type {
  GitHubInstallationClient,
  GitHubInstallationClientFactory,
  GitTreeEntry,
  PublicationStore,
} from './types.js';

const BASE = 'b'.repeat(40);
const BASE_TREE = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const POLICY_DIGEST = canonicalPublicationPolicyDigest(
  DEFAULT_PUBLICATION_POLICY,
);
const key = {
  keyId: 'publisher-2026-08',
  secret: 'publisher-authorization-secret-32-bytes',
} as const;
const issuer = createHmacAttestationIssuer<PublicationAuthorizationClaims>({
  ...key,
  kind: 'github-publication',
});
const verifier = createHmacAttestationVerifier<PublicationAuthorizationClaims>({
  kind: 'github-publication',
  keys: [key],
});

function manifest(
  overrides: Partial<PublicationManifestBody> = {},
): PublicationManifestBody {
  return {
    version: 'publication-manifest-v1',
    projectId: 'project-1',
    runId: 'run-1',
    stepId: 'publish-1',
    repository: {
      owner: 'team-zork',
      name: 'passerine',
      installationId: 42,
      repositoryId: 314159,
    },
    expectedBase: { branch: 'main', sha: BASE },
    configDigest: DIGEST,
    policyDigest: POLICY_DIGEST,
    sourceSnapshotDigest: 'f'.repeat(64),
    testEvidence: [
      { kind: 'test-report', artifactDigest: '1'.repeat(64) },
      { kind: 'policy-report', artifactDigest: '2'.repeat(64) },
    ],
    changes: [
      {
        operation: 'modify',
        path: 'src/index.ts',
        mode: '100644',
        content: 'export const answer = 42;\n',
      },
      {
        operation: 'add',
        path: 'src/new.ts',
        mode: '100755',
        content: '#!/usr/bin/env node\n',
      },
      { operation: 'delete', path: 'src/old.ts' },
    ],
    ...overrides,
  };
}

function request(body = manifest()) {
  const manifestDigest = canonicalPublicationManifestDigest(body);
  const authorization = issuer.issue({
    subject: `${body.projectId}:${body.runId}:${manifestDigest}`,
    issuedAt: '2026-08-17T11:59:00.000Z',
    claims: {
      purpose: 'publish-draft-pr',
      audience: 'github-publisher',
      projectId: body.projectId,
      runId: body.runId,
      stepId: body.stepId,
      repository: body.repository,
      expectedBase: body.expectedBase,
      configDigest: body.configDigest,
      policyDigest: body.policyDigest,
      sourceSnapshotDigest: body.sourceSnapshotDigest,
      testEvidenceDigest: canonicalPublicationManifestDigest(body.testEvidence),
      manifestDigest,
      nonce: 'trusted-nonce-1',
      expiresAt: '2026-08-17T12:05:00.000Z',
    },
  });
  return { manifest: body, authorization };
}

class FakeGitHub implements GitHubInstallationClient {
  readonly calls: Array<{ operation: string; input?: unknown }> = [];
  defaultBranch = 'main';
  baseSha = BASE;
  repositoryId = 314159;
  fullName = 'team-zork/passerine';
  tree: GitTreeEntry[] = [
    { path: 'src/index.ts', mode: '100644', type: 'blob', sha: '3'.repeat(40) },
    { path: 'src/old.ts', mode: '100644', type: 'blob', sha: '4'.repeat(40) },
  ];
  readonly blobs = new Map<string, string>();
  treeSha: string | undefined;
  commitSha: string | undefined;
  ref: { ref: string; sha: string } | undefined;
  pr:
    | {
        number: number;
        url: string;
        draft: boolean;
        state: 'open' | 'closed';
        title: string;
        head: string;
        headSha: string;
        base: string;
        baseSha: string;
        headRepositoryId: number;
        baseRepositoryId: number;
        body: string;
      }
    | undefined;
  failAfter: string | undefined;
  afterCreateReference: (() => void) | undefined;
  afterListPullRequests: (() => void) | undefined;
  afterCreatePullRequest: (() => void | Promise<void>) | undefined;
  afterCreateBlob: (() => void) | undefined;
  afterGetTree: (() => void) | undefined;

  private record(operation: string, input?: unknown): void {
    this.calls.push({ operation, input });
    if (this.failAfter === operation) {
      this.failAfter = undefined;
      throw new GitHubPublisherError(
        'github_unavailable',
        'GitHub API request failed',
      );
    }
  }

  async getBlob(sha: string) {
    const bytes = new TextEncoder().encode(this.blobs.get(sha) ?? '');
    return { sha, size: bytes.byteLength, bytes };
  }

  async getRepository() {
    this.record('getRepository');
    return {
      id: this.repositoryId,
      fullName: this.fullName,
      defaultBranch: this.defaultBranch,
    };
  }

  async getReference(branch: string) {
    this.record('getReference', branch);
    if (this.ref?.ref === `refs/heads/${branch}`) return { sha: this.ref.sha };
    if (branch === this.defaultBranch) return { sha: this.baseSha };
    return undefined;
  }

  async getCommit(sha: string) {
    this.record('getCommit', sha);
    if (sha === BASE)
      return {
        sha,
        treeSha: BASE_TREE,
        parents: [] as string[],
        message: 'base',
      };
    if (sha === this.commitSha)
      return {
        sha,
        treeSha: this.treeSha!,
        parents: [BASE],
        message: this.expectedCommitMessage(),
      };
    throw new Error('not found');
  }

  async getTree(sha: string) {
    this.record('getTree', sha);
    this.afterGetTree?.();
    return { sha, truncated: false, entries: this.tree };
  }

  async createBlob(input: { content: string; encoding: 'utf-8' }) {
    const sha = createHash('sha1')
      .update(`blob ${Buffer.byteLength(input.content)}\0${input.content}`)
      .digest('hex');
    this.blobs.set(sha, input.content);
    this.record('createBlob', input);
    this.afterCreateBlob?.();
    return { sha };
  }

  async createTree(input: { baseTree: string; entries: readonly unknown[] }) {
    this.treeSha = '5'.repeat(40);
    this.record('createTree', input);
    return { sha: this.treeSha };
  }

  async createCommit(input: {
    message: string;
    tree: string;
    parents: readonly string[];
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
  }) {
    this.commitSha = '6'.repeat(40);
    this.record('createCommit', input);
    return { sha: this.commitSha };
  }

  async createReference(input: { ref: string; sha: string }) {
    this.ref = input;
    this.record('createReference', input);
    this.afterCreateReference?.();
    return input;
  }

  async listOpenPullRequests(input: { head: string; base: string }) {
    this.record('listOpenPullRequests', input);
    this.afterListPullRequests?.();
    return this.pr === undefined ? [] : [this.pr];
  }

  async createDraftPullRequest(input: {
    title: string;
    head: string;
    base: string;
    body: string;
    draft: true;
  }) {
    this.pr = {
      number: 7,
      url: 'https://github.com/team-zork/passerine/pull/7',
      draft: input.draft,
      state: 'open',
      title: input.title,
      head: input.head,
      headSha: this.ref!.sha,
      base: input.base,
      baseSha: this.baseSha,
      headRepositoryId: this.repositoryId,
      baseRepositoryId: this.repositoryId,
      body: input.body,
    };
    await this.afterCreatePullRequest?.();
    this.pr = { ...this.pr, baseSha: this.baseSha };
    this.record('createDraftPullRequest', input);
    return this.pr;
  }

  private expectedCommitMessage() {
    const digest = canonicalPublicationManifestDigest(manifest());
    return `Agent OS run run-1\n\nAgentOS-Run: run-1\nAgentOS-Manifest: ${digest}\nAgentOS-Base: ${BASE}`;
  }
}

class FakeFactory implements GitHubInstallationClientFactory {
  readonly scopes: unknown[] = [];
  constructor(readonly client: FakeGitHub) {}
  async withClient<T>(
    scope: unknown,
    operation: (client: GitHubInstallationClient) => Promise<T>,
  ) {
    this.scopes.push(scope);
    return operation(this.client);
  }
}

function fixture(
  client = new FakeGitHub(),
  store: PublicationStore = new InMemoryPublicationStore(),
  now: (() => Date) | undefined = () => new Date('2026-08-17T12:00:00.000Z'),
  policyResolver: () => Promise<unknown> = async () =>
    DEFAULT_PUBLICATION_POLICY,
) {
  const factory = new FakeFactory(client);
  const publisher = createTrustedGitHubPublisher({
    clients: factory,
    store,
    authorizationVerifier: verifier,
    selectedRepositories: [
      {
        owner: 'team-zork',
        name: 'passerine',
        installationId: 42,
        repositoryId: 314159,
      },
    ],
    policyResolver,
    now: now ?? (() => new Date('2026-08-17T12:00:00.000Z')),
  });
  return { client, store, factory, publisher };
}

describe('trusted GitHub publisher', () => {
  it('publishes exact Git objects and one draft PR through a narrow installation client', async () => {
    const { client, factory, publisher } = fixture();
    const result = await publisher.publish(request());

    expect(result).toEqual({
      status: 'succeeded',
      branch: expect.stringMatching(/^agentos\/run-1-[0-9a-f]{8}$/),
      commitSha: '6'.repeat(40),
      pullRequestNumber: 7,
      pullRequestUrl: 'https://github.com/team-zork/passerine/pull/7',
      draft: true,
    });
    expect(factory.scopes).toEqual([
      {
        owner: 'team-zork',
        name: 'passerine',
        installationId: 42,
        repositoryId: 314159,
        repositoryIds: [314159],
        permissions: { contents: 'write', pullRequests: 'write' },
      },
    ]);
    expect(client.calls.map(({ operation }) => operation)).toEqual([
      'getRepository',
      'getReference',
      'getCommit',
      'getTree',
      'createBlob',
      'createBlob',
      'createTree',
      'createCommit',
      'getRepository',
      'getReference',
      'getReference',
      'createReference',
      'getRepository',
      'getReference',
      'getCommit',
      'getReference',
      'listOpenPullRequests',
      'getReference',
      'getReference',
      'createDraftPullRequest',
      'getReference',
      'getReference',
      'getReference',
      'getReference',
    ]);
    expect(
      client.calls.find((call) => call.operation === 'createTree')?.input,
    ).toEqual({
      baseTree: BASE_TREE,
      entries: [
        {
          path: 'src/index.ts',
          mode: '100644',
          type: 'blob',
          sha: expect.any(String),
        },
        {
          path: 'src/new.ts',
          mode: '100755',
          type: 'blob',
          sha: expect.any(String),
        },
        { path: 'src/old.ts', mode: '100644', type: 'blob', sha: null },
      ],
    });
    expect(client.pr?.draft).toBe(true);
  });

  it.each([
    'createBlob',
    'createTree',
    'createCommit',
    'createReference',
    'createDraftPullRequest',
  ])(
    'reconciles a timeout immediately after %s without a duplicate PR',
    async (boundary) => {
      const state = fixture();
      state.client.failAfter = boundary;
      if (
        boundary === 'createReference' ||
        boundary === 'createDraftPullRequest'
      ) {
        await expect(state.publisher.publish(request())).resolves.toMatchObject(
          {
            status: 'succeeded',
          },
        );
      } else {
        await expect(state.publisher.publish(request())).rejects.toMatchObject({
          code: 'github_unavailable',
        });
      }
      await expect(state.publisher.publish(request())).resolves.toMatchObject({
        status: 'succeeded',
        pullRequestNumber: 7,
      });
      expect(
        state.client.calls.filter(
          ({ operation }) => operation === 'createDraftPullRequest',
        ),
      ).toHaveLength(1);
      const phases = (await state.store.listEvents()).map(({ phase }) => phase);
      for (const phase of new Set(phases))
        expect(phases.filter((entry) => entry === phase)).toHaveLength(1);
    },
  );

  it('single-flights concurrent duplicate publication requests', async () => {
    const state = fixture();
    const [left, right] = await Promise.all([
      state.publisher.publish(request()),
      state.publisher.publish(request()),
    ]);
    expect(left).toEqual(right);
    expect(
      state.client.calls.filter(
        ({ operation }) => operation === 'createReference',
      ),
    ).toHaveLength(1);
    expect(
      state.client.calls.filter(
        ({ operation }) => operation === 'createDraftPullRequest',
      ),
    ).toHaveLength(1);
  });

  it('exposes sanitized durable status and cancellation without GitHub mutation', async () => {
    const state = fixture();
    await expect(state.publisher.status(request())).resolves.toEqual({
      status: 'not_found',
    });
    state.client.failAfter = 'createCommit';
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'github_unavailable',
    });
    const writes = state.client.calls.filter(({ operation }) =>
      operation.startsWith('create'),
    ).length;
    const cancelled = await state.publisher.cancel(request());
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      branch: expect.stringMatching(/^agentos\//),
    });
    expect(cancelled).not.toHaveProperty('errorCode');
    expect(
      state.client.calls.filter(({ operation }) =>
        operation.startsWith('create'),
      ),
    ).toHaveLength(writes);
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_cancelled',
    });
  });

  it('resumes from the durable PR checkpoint without regressing after the base advances', async () => {
    const durable = new InMemoryPublicationStore();
    let failSucceededCheckpoint = true;
    const store: PublicationStore = {
      claim: (input) => durable.claim(input),
      get: (key) => durable.get(key),
      listEvents: () => durable.listEvents(),
      save: (key, revision, patch, publicationEvent) => {
        if (patch.phase === 'succeeded' && failSucceededCheckpoint) {
          failSucceededCheckpoint = false;
          throw new Error('database connection reset');
        }
        return durable.save(key, revision, patch, publicationEvent);
      },
    };
    const state = fixture(new FakeGitHub(), store);
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'github_unavailable',
    });
    const writesBeforeReplay = state.client.calls.filter(({ operation }) =>
      operation.startsWith('create'),
    ).length;
    state.client.baseSha = '9'.repeat(40);

    await expect(state.publisher.publish(request())).resolves.toMatchObject({
      status: 'succeeded',
      pullRequestNumber: 7,
    });
    expect(
      state.client.calls.filter(({ operation }) =>
        operation.startsWith('create'),
      ),
    ).toHaveLength(writesBeforeReplay);
    expect((await durable.listEvents()).map(({ phase }) => phase)).toEqual([
      'claimed',
      'blobs_created',
      'tree_created',
      'commit_created',
      'ref_created',
      'pr_created',
      'succeeded',
    ]);
  });

  it('reconciles a durable success against GitHub and rejects later ref or PR tampering', async () => {
    const state = fixture();
    await state.publisher.publish(request());
    state.client.ref = {
      ref: state.client.ref!.ref,
      sha: '8'.repeat(40),
    };
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });

    state.client.ref = {
      ref: state.client.ref.ref,
      sha: state.client.commitSha!,
    };
    state.client.pr = { ...state.client.pr!, draft: false };
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });

    state.client.pr = {
      ...state.client.pr!,
      draft: true,
      headRepositoryId: 999,
    };
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });

    state.client.pr = {
      ...state.client.pr!,
      headRepositoryId: 314159,
      headSha: '9'.repeat(40),
    };
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });

    state.client.pr = {
      ...state.client.pr!,
      headSha: state.client.commitSha!,
      baseSha: '9'.repeat(40),
    };
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });
  });

  it('rejects ref races before and after draft PR creation without checkpointing ownership', async () => {
    const before = fixture();
    before.client.afterListPullRequests = () => {
      before.client.ref = {
        ref: before.client.ref!.ref,
        sha: '9'.repeat(40),
      };
    };
    await expect(before.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });
    expect(before.client.pr).toBeUndefined();

    const after = fixture();
    after.client.afterCreatePullRequest = () => {
      after.client.ref = {
        ref: after.client.ref!.ref,
        sha: '9'.repeat(40),
      };
    };
    await expect(after.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });
    expect(
      (await after.store.listEvents()).map(({ phase }) => phase),
    ).not.toContain('pr_created');
  });

  it('rejects a PR created against an advanced base and never accepts it on replay', async () => {
    const state = fixture();
    const advancedBase = '9'.repeat(40);
    state.client.afterCreatePullRequest = () => {
      state.client.baseSha = advancedBase;
    };

    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_rejected',
    });
    expect(state.client.pr).toMatchObject({ baseSha: advancedBase });
    expect(
      (await state.store.listEvents()).map(({ phase }) => phase),
    ).not.toEqual(expect.arrayContaining(['pr_created', 'succeeded']));

    state.client.afterCreatePullRequest = undefined;
    state.client.baseSha = BASE;
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });
    expect(
      state.client.calls.filter(
        ({ operation }) => operation === 'createDraftPullRequest',
      ),
    ).toHaveLength(1);
    expect(
      (await state.store.listEvents()).map(({ phase }) => phase),
    ).not.toEqual(expect.arrayContaining(['pr_created', 'succeeded']));
  });

  it.each([
    ['closed state', { state: 'closed' as const }],
    ['changed title', { title: 'Looks trusted' }],
    ['changed body', { body: '<!-- copied marker -->' }],
  ])('rejects a durable PR with %s', async (_label, change) => {
    const state = fixture();
    await state.publisher.publish(request());
    state.client.pr = { ...state.client.pr!, ...change };
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });
  });

  it('requires the trusted resolved policy digest and applies custom denies to every operation', async () => {
    const customPolicy = {
      ...DEFAULT_PUBLICATION_POLICY,
      protectedPaths: [
        ...DEFAULT_PUBLICATION_POLICY.protectedPaths,
        'private/**',
      ],
    } as const;
    const customDigest = canonicalPublicationPolicyDigest(customPolicy);
    for (const change of [
      {
        operation: 'add',
        path: 'private/new.ts',
        mode: '100644',
        content: 'new',
      },
      {
        operation: 'modify',
        path: 'private/existing.ts',
        mode: '100644',
        content: 'changed',
      },
      { operation: 'delete', path: 'private/existing.ts' },
    ] as const) {
      const client = new FakeGitHub();
      client.tree.push({
        path: 'private/existing.ts',
        mode: '100644',
        type: 'blob',
        sha: '7'.repeat(40),
      });
      const state = fixture(
        client,
        new InMemoryPublicationStore(),
        undefined,
        async () => customPolicy,
      );
      const body = manifest({
        policyDigest: customDigest,
        changes: [change] as PublicationManifestBody['changes'],
      });
      await expect(
        state.publisher.publish(request(body)),
      ).rejects.toMatchObject({ code: 'publication_rejected' });
      expect(state.client.calls).toHaveLength(0);
    }

    const mismatch = fixture(
      new FakeGitHub(),
      new InMemoryPublicationStore(),
      undefined,
      async () => customPolicy,
    );
    await expect(mismatch.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_rejected',
    });
    const removedDefaults = fixture(
      new FakeGitHub(),
      new InMemoryPublicationStore(),
      undefined,
      async () => ({ ...DEFAULT_PUBLICATION_POLICY, protectedPaths: [] }),
    );
    await expect(
      removedDefaults.publisher.publish(request()),
    ).rejects.toMatchObject({ code: 'publication_rejected' });

    const modePolicy = {
      ...DEFAULT_PUBLICATION_POLICY,
      allowedModes: ['100644'] as const,
    };
    const modeClient = new FakeGitHub();
    modeClient.tree[0] = { ...modeClient.tree[0]!, mode: '100755' };
    const modeState = fixture(
      modeClient,
      new InMemoryPublicationStore(),
      undefined,
      async () => modePolicy,
    );
    const modeBody = manifest({
      policyDigest: canonicalPublicationPolicyDigest(modePolicy),
      changes: [
        {
          operation: 'modify',
          path: 'src/index.ts',
          mode: '100644',
          content: 'safe',
        },
      ],
    });
    await expect(
      modeState.publisher.publish(request(modeBody)),
    ).rejects.toMatchObject({ code: 'publication_rejected' });
  });

  it('rechecks publication authorization before every Git mutation', async () => {
    let current = new Date('2026-08-17T12:00:00.000Z');
    const client = new FakeGitHub();
    client.afterCreateBlob = () => {
      current = new Date('2026-08-17T12:06:00.000Z');
    };
    const state = fixture(
      client,
      new InMemoryPublicationStore(),
      () => current,
    );
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_rejected',
    });
    expect(
      client.calls.filter(({ operation }) => operation === 'createBlob'),
    ).toHaveLength(1);
    expect(
      client.calls.some(({ operation }) => operation === 'createTree'),
    ).toBe(false);
  });

  it('allows unrelated protected files already present in the trusted base tree', async () => {
    const state = fixture();
    state.client.tree.push({
      path: '.github/workflows/ci.yml',
      mode: '100644',
      type: 'blob',
      sha: 'a'.repeat(40),
    });
    await expect(state.publisher.publish(request())).resolves.toMatchObject({
      status: 'succeeded',
    });
  });

  it('rejects a server tree whose file entries conflict with changed directory shape', async () => {
    const state = fixture();
    state.client.tree.push({
      path: 'src/generated',
      mode: '100644',
      type: 'blob',
      sha: 'a'.repeat(40),
    });
    const body = manifest({
      changes: [
        {
          operation: 'add',
          path: 'src/generated/index.ts',
          mode: '100644',
          content: 'new',
        },
      ],
    });
    await expect(state.publisher.publish(request(body))).rejects.toMatchObject({
      code: 'publication_rejected',
    });
  });

  it('fails closed for stale base, default-branch changes, repository mismatch, and unsafe server tree entries', async () => {
    for (const mutate of [
      (client: FakeGitHub) => {
        client.baseSha = '9'.repeat(40);
      },
      (client: FakeGitHub) => {
        client.defaultBranch = 'trunk';
      },
      (client: FakeGitHub) => {
        client.repositoryId = 999;
      },
      (client: FakeGitHub) => {
        client.tree = [
          {
            path: 'src/index.ts',
            mode: '120000',
            type: 'blob',
            sha: '3'.repeat(40),
          },
          {
            path: 'src/old.ts',
            mode: '100644',
            type: 'blob',
            sha: '4'.repeat(40),
          },
        ];
      },
      (client: FakeGitHub) => {
        client.tree.push({
          path: 'SRC/INDEX.ts',
          mode: '100644',
          type: 'blob',
          sha: '7'.repeat(40),
        });
      },
      (client: FakeGitHub) => {
        client.tree.push({
          path: 'SRC/NEW.ts',
          mode: '100644',
          type: 'blob',
          sha: '7'.repeat(40),
        });
      },
    ]) {
      const state = fixture();
      mutate(state.client);
      await expect(state.publisher.publish(request())).rejects.toMatchObject({
        code: 'publication_rejected',
      });
      expect(state.client.ref).toBeUndefined();
    }
  });

  it('rejects foreign branch and PR collisions without mutating or deleting them', async () => {
    const branchState = fixture();
    const branch = branchState.publisher.branchFor(request());
    branchState.client.ref = {
      ref: `refs/heads/${branch}`,
      sha: '8'.repeat(40),
    };
    await expect(
      branchState.publisher.publish(request()),
    ).rejects.toMatchObject({
      code: 'publication_collision',
    });

    const prState = fixture();
    prState.client.pr = {
      number: 99,
      url: 'https://github.com/team-zork/passerine/pull/99',
      draft: true,
      state: 'open',
      title: 'Agent OS: run-1',
      head: prState.publisher.branchFor(request()),
      headSha: '8'.repeat(40),
      base: 'main',
      baseSha: BASE,
      headRepositoryId: 999,
      baseRepositoryId: 314159,
      body: 'foreign',
    };
    await expect(prState.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_collision',
    });
    expect(prState.client.pr!.number).toBe(99);
  });

  it('rejects a copied ownership marker when the PR head SHA is foreign', async () => {
    const state = fixture();
    const publication = manifest();
    const digest = canonicalPublicationManifestDigest(publication);
    const branch = state.publisher.branchFor(request(publication));
    state.client.pr = {
      number: 99,
      url: 'https://github.com/team-zork/passerine/pull/99',
      draft: true,
      state: 'open',
      title: 'Agent OS: run-1',
      head: branch,
      headSha: '9'.repeat(40),
      base: 'main',
      baseSha: BASE,
      headRepositoryId: 314159,
      baseRepositoryId: 314159,
      body: `<!-- agentos:run=run-1;manifest=${digest};base=${BASE} -->\n\nAutomated draft. Review and merge manually.`,
    };
    await expect(
      state.publisher.publish(request(publication)),
    ).rejects.toMatchObject({ code: 'publication_collision' });
    expect(
      state.client.calls.filter(
        ({ operation }) => operation === 'createDraftPullRequest',
      ),
    ).toHaveLength(0);
  });

  it('checks cancellation before creating the public ref and leaves only orphaned immutable objects', async () => {
    let cancelled = false;
    const state = fixture();
    const publisher = createTrustedGitHubPublisher({
      clients: state.factory,
      store: state.store,
      authorizationVerifier: verifier,
      selectedRepositories: [manifest().repository],
      policyResolver: async () => DEFAULT_PUBLICATION_POLICY,
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      isCancelled: async () => cancelled,
      beforeReference: () => {
        cancelled = true;
      },
    });
    await expect(publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_cancelled',
    });
    expect(state.client.commitSha).toBeDefined();
    expect(state.client.ref).toBeUndefined();
  });

  it('records cancellation after ref creation and never opens a PR', async () => {
    let cancelled = false;
    const state = fixture();
    state.client.afterCreateReference = () => {
      cancelled = true;
    };
    const publisher = createTrustedGitHubPublisher({
      clients: state.factory,
      store: state.store,
      authorizationVerifier: verifier,
      selectedRepositories: [manifest().repository],
      policyResolver: async () => DEFAULT_PUBLICATION_POLICY,
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      isCancelled: async () => cancelled,
    });
    await expect(publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_cancelled',
    });
    expect(state.client.ref?.sha).toBe(state.client.commitSha);
    expect(state.client.pr).toBeUndefined();
    expect(await state.store.listEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'ref_created' }),
        expect.objectContaining({ phase: 'cancelled' }),
      ]),
    );
  });

  it('records an owned PR reconciled during cancellation without further mutation', async () => {
    let cancelled = false;
    const state = fixture();
    state.client.failAfter = 'createDraftPullRequest';
    state.client.afterCreatePullRequest = () => {
      cancelled = true;
    };
    const publisher = createTrustedGitHubPublisher({
      clients: state.factory,
      store: state.store,
      authorizationVerifier: verifier,
      selectedRepositories: [manifest().repository],
      policyResolver: async () => DEFAULT_PUBLICATION_POLICY,
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      isCancelled: async () => cancelled,
    });
    await expect(publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_cancelled',
    });
    expect(state.client.pr).toMatchObject({ draft: true, state: 'open' });
    expect((await state.store.listEvents()).at(-1)).toMatchObject({
      phase: 'cancelled',
      details: { pullRequestNumber: 7 },
    });
  });

  it('enriches a concurrent terminal cancellation with the PR that completed in flight', async () => {
    const state = fixture();
    state.client.afterCreatePullRequest = async () => {
      await state.publisher.cancel(request());
    };
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_cancelled',
    });
    await expect(state.publisher.status(request())).resolves.toMatchObject({
      status: 'cancelled',
      pullRequestNumber: 7,
      pullRequestUrl: 'https://github.com/team-zork/passerine/pull/7',
      draft: true,
    });
    expect(
      state.client.calls.filter(
        ({ operation }) => operation === 'createDraftPullRequest',
      ),
    ).toHaveLength(1);
  });

  it('checks cancellation again after the PR checkpoint and before success', async () => {
    const durable = new InMemoryPublicationStore();
    let cancelled = false;
    const store: PublicationStore = {
      claim: (input) => durable.claim(input),
      get: (key) => durable.get(key),
      listEvents: () => durable.listEvents(),
      save: async (key, revision, patch, publicationEvent) => {
        const saved = await durable.save(
          key,
          revision,
          patch,
          publicationEvent,
        );
        if (patch.phase === 'pr_created') cancelled = true;
        return saved;
      },
    };
    const state = fixture(new FakeGitHub(), store);
    const publisher = createTrustedGitHubPublisher({
      clients: state.factory,
      store,
      authorizationVerifier: verifier,
      selectedRepositories: [manifest().repository],
      policyResolver: async () => DEFAULT_PUBLICATION_POLICY,
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      isCancelled: async () => cancelled,
    });
    await expect(publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_cancelled',
    });
    expect(
      (await durable.listEvents()).map(({ phase }) => phase).slice(-2),
    ).toEqual(['pr_created', 'cancelled']);
  });

  it('rejects base changes immediately before and after ref creation without opening a PR', async () => {
    for (const when of ['before', 'after'] as const) {
      const state = fixture();
      const publisher = createTrustedGitHubPublisher({
        clients: state.factory,
        store: state.store,
        authorizationVerifier: verifier,
        selectedRepositories: [manifest().repository],
        policyResolver: async () => DEFAULT_PUBLICATION_POLICY,
        now: () => new Date('2026-08-17T12:00:00.000Z'),
        ...(when === 'before'
          ? {
              beforeReference: () => {
                state.client.baseSha = '9'.repeat(40);
              },
            }
          : {}),
      });
      if (when === 'after') {
        state.client.afterCreateReference = () => {
          state.client.baseSha = '9'.repeat(40);
        };
      }
      await expect(publisher.publish(request())).rejects.toMatchObject({
        code: 'publication_rejected',
      });
      expect(state.client.pr).toBeUndefined();
      if (when === 'after') {
        await expect(publisher.publish(request())).rejects.toMatchObject({
          code: 'publication_rejected',
        });
        expect(state.client.pr).toBeUndefined();
        expect(
          (await state.store.listEvents()).map(({ phase }) => phase),
        ).toContain('ref_created');
      }
    }
  });

  it('reverifies publication authority immediately before the first GitHub write', async () => {
    const state = fixture();
    let clock = new Date('2026-08-17T12:00:00.000Z');
    state.client.afterGetTree = () => {
      clock = new Date('2026-08-17T12:06:00.000Z');
    };
    const publisher = createTrustedGitHubPublisher({
      clients: state.factory,
      store: state.store,
      authorizationVerifier: verifier,
      selectedRepositories: [manifest().repository],
      policyResolver: async () => DEFAULT_PUBLICATION_POLICY,
      now: () => clock,
    });
    await expect(publisher.publish(request())).rejects.toMatchObject({
      code: 'publication_rejected',
    });
    expect(state.client.blobs.size).toBe(0);
    expect(state.client.ref).toBeUndefined();
  });

  it('redacts hostile API errors and never returns credentials or generic mutation methods', async () => {
    const state = fixture();
    state.client.failAfter = 'getRepository';
    await expect(state.publisher.publish(request())).rejects.toMatchObject({
      code: 'github_unavailable',
      message: 'GitHub API request failed',
    });
    expect(JSON.stringify(await state.store.listEvents())).not.toContain(
      'ghs_',
    );
    expect('merge' in state.client).toBe(false);
    expect('request' in state.client).toBe(false);
  });
});
