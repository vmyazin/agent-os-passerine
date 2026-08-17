import { describe, expect, it, vi } from 'vitest';

import { InMemoryDomainRepository } from '@agentos/adapters';
import type { ArtifactAdminStore, ArtifactManifestStore } from '@agentos/core';

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
      }),
      runArtifactRetentionCleanup({
        repository,
        manifest,
        admin,
        owner: 'worker-two',
        now,
      }),
    ]);
    expect(runs.filter((result) => result.skipped)).toHaveLength(1);
    expect(runs.filter((result) => !result.skipped)).toHaveLength(1);
    expect(manifest.listExpired).toHaveBeenCalledTimes(1);
  });

  it('renews its owner lease and drains more than one hundred due rows', async () => {
    const repository = new InMemoryDomainRepository();
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
  });
});
