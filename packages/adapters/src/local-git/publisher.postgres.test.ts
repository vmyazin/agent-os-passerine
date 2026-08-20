import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import {
  canonicalPublicationManifestDigest,
  canonicalPublicationPolicyDigest,
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  DEFAULT_PUBLICATION_POLICY,
  type PublicationAuthorizationClaims,
  type PublicationManifestBody,
} from '@agentos/core';
import { neon } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresPublicationStoreForTest } from '../github/postgres-store.js';
import { createLocalGitPublisher } from './publisher.js';
import { cleanupFixtures, fixtureRoot, seedRepo } from './test-support.js';

const exec = promisify(execFile);

// Mirrors the gating pattern packages/adapters/src/persistence/
// postgres.integration.test.ts uses: skip the whole suite unless
// TEST_DATABASE_URL is set, so this never blocks a normal `pnpm test` run
// without a real database configured.
const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

// Deliberately reuses the already-migrated "public" schema rather than
// creating a fresh per-run schema the way postgres.integration.test.ts
// does: this suite uses `@neondatabase/serverless`'s `neon()` -- the exact
// driver `createNeonPublicationStore` uses in production, which is the
// whole point of this test -- and empirically, `neon()`'s HTTP transport
// does not honor a `?options=-c search_path=...` connection-string
// override the way a real libpq connection would (confirmed: `show
// search_path` still reports the default after setting it). Isolation
// instead comes from every row this suite touches being keyed by a fresh
// `randomUUID()` project/run id, cleaned up in `afterAll`.
const POLICY_DIGEST = canonicalPublicationPolicyDigest(
  DEFAULT_PUBLICATION_POLICY,
);
const key = {
  keyId: 'local-publisher-postgres-2026-08',
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

function manifestBody(
  projectId: string,
  runId: string,
  repositoryName: string,
  base: string,
  overrides: Partial<PublicationManifestBody> = {},
): PublicationManifestBody {
  return {
    version: 'publication-manifest-v1',
    projectId,
    runId,
    stepId: 'publish-1',
    repository: { kind: 'local', owner: 'local', name: repositoryName },
    expectedBase: { branch: 'main', sha: base },
    configDigest: 'a'.repeat(64),
    policyDigest: POLICY_DIGEST,
    sourceSnapshotDigest: 'b'.repeat(64),
    testEvidence: [{ kind: 'test-report', artifactDigest: 'c'.repeat(64) }],
    changes: [
      {
        operation: 'add',
        path: 'new.txt',
        mode: '100644',
        content: 'x\n',
      },
    ],
    ...overrides,
  };
}

function authorize(manifest: PublicationManifestBody) {
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
      nonce: 'postgres-integration-nonce',
      expiresAt: '2026-08-17T12:05:00.000Z',
    },
  });
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args]);
  return stdout.trim();
}

describePostgres(
  'local git publisher against the real PostgresPublicationStore',
  () => {
    // `neon()` is constructed inside `beforeAll`, not eagerly in this
    // describe body: `describe.skip` still *executes* the describe
    // callback to discover its tests (only the `it()` bodies are skipped),
    // so anything here that requires `databaseUrl` to be defined must be
    // deferred into a hook -- otherwise this suite crashes even when
    // TEST_DATABASE_URL is unset, defeating the whole point of gating it.
    let sql: ReturnType<typeof neon>;
    const cleanupRunIds: string[] = [];
    const cleanupProjectIds: string[] = [];

    beforeAll(() => {
      sql = neon(databaseUrl!, { arrayMode: false, fullResults: false });
    });

    afterAll(async () => {
      await cleanupFixtures();
      // Every deletion is individually guarded: one failure must not abort
      // the remaining cleanup and leak fixture rows into the shared test
      // database.
      const attempt = async (statement: string, parameter: string) => {
        try {
          await sql.query(statement, [parameter]);
        } catch {
          // Best-effort cleanup; a failed delete surfaces as a leftover row
          // on the next audit rather than cascading into more leaks now.
        }
      };
      for (const runId of cleanupRunIds) {
        await attempt(
          'delete from "publication_events" where "publication_key" in (select "publication_key" from "publication_records" where "run_id" = $1)',
          runId,
        );
        await attempt(
          'delete from "publication_records" where "run_id" = $1',
          runId,
        );
        await attempt('delete from "workflow_runs" where "id" = $1', runId);
      }
      for (const projectId of cleanupProjectIds) {
        await attempt('delete from "projects" where "id" = $1', projectId);
      }
    });

    async function fixture() {
      const projectId = `project-${randomUUID()}`;
      const runId = `run-${randomUUID()}`;
      cleanupProjectIds.push(projectId);
      cleanupRunIds.push(runId);
      await sql.query(
        'insert into "projects" ("id", "name", "created_at", "updated_at") values ($1, $2, now(), now())',
        [projectId, 'local git publisher postgres integration test'],
      );
      await sql.query(
        'insert into "workflow_runs" ("id", "project_id", "pipeline", "status", "created_at", "updated_at") values ($1, $2, $3, $4, now(), now())',
        [runId, projectId, 'default', 'running'],
      );

      const root = await fixtureRoot();
      const repo = await seedRepo(root, 'exp-repo');
      const base = await git(repo, ['rev-parse', 'HEAD']);

      // This is the exact bridge `createNeonPublicationStore` uses in
      // production (packages/adapters/src/github/postgres-store.ts) --
      // not a mock, and not a different SQL driver -- so this test
      // exercises the real `agentos_claim_publication`/
      // `agentos_save_publication` SQL functions and every CHECK
      // constraint on `publication_records`, which is exactly what an
      // `InMemoryPublicationStore`-backed test cannot do.
      const store = createPostgresPublicationStoreForTest({
        execute: async (query, parameters) =>
          (await sql.query(query, [...parameters])) as readonly unknown[],
      });

      return { projectId, runId, root, repo, base, store };
    }

    it('publishes on the first attempt -- no crash, no replay needed', async () => {
      const { projectId, runId, repo, root, base, store } = await fixture();
      const manifest = manifestBody(projectId, runId, 'exp-repo', base);
      const publisher = createLocalGitPublisher({
        workspacesRoot: root,
        localPath: repo,
        verifier,
        store,
        now: () => new Date('2026-08-17T12:00:00.000Z'),
      });

      const result = await publisher.publish({
        manifest,
        authorization: authorize(manifest),
      });

      expect(result).toEqual({
        status: 'succeeded',
        local: true,
        branch: expect.stringMatching(/^agentos\/run-[a-f0-9-]+-[0-9a-f]{8}$/),
        commitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
        repositoryUrl: `file://${repo}`,
      });

      const branchSha = await git(repo, [
        'rev-parse',
        `refs/heads/${result.branch}`,
      ]);
      expect(branchSha).toBe(result.commitSha);
    });

    it('replays idempotently against the durable store without a second commit', async () => {
      const { projectId, runId, repo, root, base, store } = await fixture();
      const manifest = manifestBody(projectId, runId, 'exp-repo', base);
      const authorization = authorize(manifest);
      const publisher1 = createLocalGitPublisher({
        workspacesRoot: root,
        localPath: repo,
        verifier,
        store,
        now: () => new Date('2026-08-17T12:00:00.000Z'),
      });

      const first = await publisher1.publish({ manifest, authorization });

      // A fresh publisher instance, sharing the same durable store.
      const publisher2 = createLocalGitPublisher({
        workspacesRoot: root,
        localPath: repo,
        verifier,
        store,
        now: () => new Date('2026-08-17T12:01:00.000Z'),
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
  },
);
