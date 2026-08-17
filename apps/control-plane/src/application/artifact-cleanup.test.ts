import { describe, expect, it, vi } from 'vitest';

import { InMemoryDomainRepository } from '@agentos/adapters';
import type { ArtifactAdminStore, ArtifactManifestStore } from '@agentos/core';

import { runArtifactRetentionCleanup } from './artifact-cleanup';

const now = new Date('2026-08-17T01:00:00.000Z');
const manifest: ArtifactManifestStore = {
  claim: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  listExpired: vi.fn(async () => ({ items: [], invalidCount: 0 })),
  markDeleted: vi.fn(),
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
});
