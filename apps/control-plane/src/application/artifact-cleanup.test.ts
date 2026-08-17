import { describe, expect, it, vi } from 'vitest';

import { InMemoryDomainRepository } from '@agentos/adapters';
import {
  isoTimestamp,
  type ArtifactAdminStore,
  type ArtifactManifestStore,
} from '@agentos/core';

import { runArtifactRetentionCleanup } from './artifact-cleanup';

const now = new Date('2026-08-17T01:00:00.000Z');
const manifest: ArtifactManifestStore = {
  claim: vi.fn(),
  beginWrite: vi.fn(),
  finishWrite: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  listExpired: vi.fn(async () => ({ items: [], invalidCount: 0 })),
  reserveDeletion: vi.fn(),
  finalizeDeletion: vi.fn(),
};
const admin: ArtifactAdminStore = { delete: vi.fn() };

describe('artifact retention cleanup job', () => {
  it('uses a durable repository lease so concurrent workers run once', async () => {
    const repository = new InMemoryDomainRepository();
    const runs = await Promise.all([
      runArtifactRetentionCleanup({
        repository,
        manifest,
        admin,
        owner: 'worker-one',
        now,
        clock: () => now,
      }),
      runArtifactRetentionCleanup({
        repository,
        manifest,
        admin,
        owner: 'worker-two',
        now,
        clock: () => now,
      }),
    ]);
    expect(runs.filter((result) => result.skipped)).toHaveLength(1);
    expect(runs.filter((result) => !result.skipped)).toHaveLength(1);
    expect(manifest.listExpired).toHaveBeenCalledTimes(1);
  });

  it('renews its owner lease and drains more than one hundred due rows', async () => {
    const repository = new InMemoryDomainRepository();
    const renew = vi.spyOn(repository, 'renewArtifactCleanupLease');
    const remaining = new Set(
      Array.from({ length: 125 }, (_, index) => `artifact-${index}`),
    );
    const drainingManifest: ArtifactManifestStore = {
      ...manifest,
      listExpired: vi.fn(async (_before, limit) => ({
        items: [...remaining].slice(0, limit).map((key) => ({ key }) as never),
        invalidCount: 0,
      })),
    };
    const drainingAdmin: ArtifactAdminStore = {
      async delete(key) {
        return remaining.delete(key);
      },
    };
    const result = await runArtifactRetentionCleanup({
      repository,
      manifest: drainingManifest,
      admin: drainingAdmin,
      owner: 'draining-worker',
      now,
      clock: () => now,
      limit: 25,
    });
    expect(result).toEqual({
      skipped: false,
      inspected: 125,
      deleted: 125,
      failed: 0,
    });
    expect(remaining).toHaveLength(0);
    expect(drainingManifest.listExpired).toHaveBeenCalledTimes(6);
    expect(renew).toHaveBeenCalledTimes(70);
  });

  it('aborts a stalled concurrency group before its execution budget expires', async () => {
    const repository = new InMemoryDomainRepository();
    let active = 0;
    let aborted = 0;
    const stalledManifest: ArtifactManifestStore = {
      ...manifest,
      listExpired: vi.fn(async () => ({
        items: Array.from({ length: 4 }, (_, index) => ({
          key: `artifact-${index}`,
        })) as never,
        invalidCount: 0,
      })),
    };
    const stalledAdmin: ArtifactAdminStore = {
      delete(_key, _audit, operation) {
        active += 1;
        return new Promise<boolean>((_resolve, reject) => {
          if (operation?.signal === undefined) return;
          operation.signal.addEventListener(
            'abort',
            () => {
              active -= 1;
              aborted += 1;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      },
    };
    const startedAt = new Date();
    const result = await runArtifactRetentionCleanup({
      repository,
      manifest: stalledManifest,
      admin: stalledAdmin,
      owner: 'stalled-worker',
      now: startedAt,
      limit: 4,
      timeBudgetMs: 200,
      safetyMarginMs: 50,
    });
    expect(result).toMatchObject({ skipped: false, deleted: 0, failed: 4 });
    expect(active).toBe(0);
    expect(aborted).toBe(4);
    await expect(
      repository.claimArtifactCleanupLease({
        owner: 'next-cron',
        now: isoTimestamp(
          new Date(startedAt.getTime() + 10 * 60_000).toISOString(),
        ),
        expiresAt: isoTimestamp(
          new Date(startedAt.getTime() + 15 * 60_000).toISOString(),
        ),
      }),
    ).resolves.toBe(true);
  }, 1_000);

  it('rejects unsafe cleanup page sizes', async () => {
    await expect(
      runArtifactRetentionCleanup({
        repository: new InMemoryDomainRepository(),
        manifest,
        admin,
        owner: 'unsafe-page',
        now,
        limit: 100,
      }),
    ).rejects.toThrow(/limit/i);
  });
});
