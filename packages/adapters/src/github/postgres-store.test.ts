import { describe, expect, it, vi } from 'vitest';

import {
  createPostgresPublicationStoreForTest,
  type PublicationSqlExecutor,
} from './postgres-store.js';

const row = {
  key: 'publication-key',
  bindingKey: 'binding-key',
  projectId: 'project-1',
  runId: 'run-1',
  repositoryId: '314159',
  manifestDigest: 'a'.repeat(64),
  policyDigest: 'b'.repeat(64),
  baseSha: 'c'.repeat(40),
  branch: 'agentos/run-1-12345678',
  phase: 'claimed',
  blobShas: null,
  treeSha: null,
  commitSha: null,
  pullRequestNumber: null,
  pullRequestUrl: null,
  draft: null,
  errorCode: null,
  revision: '1',
  createdAt: '2026-08-17T12:00:00.000000Z',
  updatedAt: '2026-08-17T12:00:00.000000Z',
};

describe('PostgreSQL publication store', () => {
  it('claims and saves through single atomic database functions', async () => {
    const execute = vi
      .fn<PublicationSqlExecutor['execute']>()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([
        {
          ...row,
          phase: 'tree_created',
          treeSha: 'd'.repeat(40),
          revision: '2',
        },
      ])
      .mockResolvedValueOnce([
        {
          publicationKey: 'publication-key',
          phase: 'claimed',
          at: '2026-08-17T12:00:00.000000Z',
          details: {},
        },
      ]);
    const store = createPostgresPublicationStoreForTest({ execute });

    const claimed = await store.claim({
      key: 'publication-key',
      bindingKey: 'binding-key',
      projectId: 'project-1',
      runId: 'run-1',
      repositoryId: 314159,
      manifestDigest: 'a'.repeat(64),
      policyDigest: 'b'.repeat(64),
      baseSha: 'c'.repeat(40),
      branch: 'agentos/run-1-12345678',
      now: '2026-08-17T12:00:00.000Z',
    });
    expect(claimed).toMatchObject({ repositoryId: 314159, revision: 1 });

    await expect(
      store.save(
        'publication-key',
        1,
        {
          phase: 'tree_created',
          treeSha: 'd'.repeat(40),
          updatedAt: '2026-08-17T12:00:01.000Z',
        },
        {
          publicationKey: 'publication-key',
          phase: 'tree_created',
          at: '2026-08-17T12:00:01.000Z',
          details: { treeSha: 'd'.repeat(40) },
        },
      ),
    ).resolves.toMatchObject({ phase: 'tree_created', revision: 2 });
    await expect(store.listEvents()).resolves.toHaveLength(1);

    expect(execute.mock.calls[0]?.[0]).toContain('agentos_claim_publication');
    expect(execute.mock.calls[1]?.[0]).toContain('agentos_save_publication');
    expect(execute.mock.calls[1]?.[1]).toEqual([
      'publication-key',
      1,
      'tree_created',
      JSON.stringify({ treeSha: 'd'.repeat(40) }),
      '2026-08-17T12:00:01.000Z',
      JSON.stringify({ treeSha: 'd'.repeat(40) }),
    ]);
  });

  it('maps database conflicts to a sanitized durable-store conflict', async () => {
    const execute = vi
      .fn<PublicationSqlExecutor['execute']>()
      .mockRejectedValue(
        Object.assign(
          new Error('agentos_publication_conflict secret row data'),
          {
            code: 'P0001',
          },
        ),
      );
    const store = createPostgresPublicationStoreForTest({ execute });
    await expect(
      store.claim({
        key: 'publication-key',
        bindingKey: 'binding-key',
        projectId: 'project-1',
        runId: 'run-1',
        repositoryId: 314159,
        manifestDigest: 'a'.repeat(64),
        policyDigest: 'b'.repeat(64),
        baseSha: 'c'.repeat(40),
        branch: 'agentos/run-1-12345678',
        now: '2026-08-17T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'publication_collision',
      message: 'Publication binding conflicts with durable state',
    });
  });

  it('fails closed on unsafe bigint and malformed rows', async () => {
    const execute = vi
      .fn<PublicationSqlExecutor['execute']>()
      .mockResolvedValue([{ ...row, revision: '9007199254740992' }]);
    const store = createPostgresPublicationStoreForTest({ execute });
    await expect(store.get('publication-key')).rejects.toMatchObject({
      code: 'publication_store_conflict',
    });
  });

  it('rejects an event that is not exactly bound to its checkpoint', async () => {
    const execute = vi.fn<PublicationSqlExecutor['execute']>();
    const store = createPostgresPublicationStoreForTest({ execute });
    await expect(
      store.save(
        'publication-key',
        1,
        {
          phase: 'tree_created',
          updatedAt: '2026-08-17T12:00:01.000Z',
        },
        {
          publicationKey: 'other-key',
          phase: 'commit_created',
          at: '2026-08-17T12:00:02.000Z',
          details: {},
        },
      ),
    ).rejects.toMatchObject({ code: 'publication_store_conflict' });
    expect(execute).not.toHaveBeenCalled();
  });
});
