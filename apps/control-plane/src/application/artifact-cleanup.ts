import { cleanupExpiredArtifacts } from '@agentos/adapters';
import {
  isoTimestamp,
  type ArtifactAdminStore,
  type ArtifactManifestStore,
  type DomainRepository,
} from '@agentos/core';

export interface ArtifactRetentionCleanupJobOptions {
  readonly repository: DomainRepository;
  readonly manifest: ArtifactManifestStore;
  readonly admin: ArtifactAdminStore;
  readonly owner: string;
  readonly now: Date;
  readonly limit?: number;
  readonly clock?: () => Date;
  readonly timeBudgetMs?: number;
}

export interface ArtifactRetentionCleanupJobResult {
  readonly skipped: boolean;
  readonly inspected: number;
  readonly deleted: number;
  readonly failed: number;
}

export async function runArtifactRetentionCleanup(
  options: ArtifactRetentionCleanupJobOptions,
): Promise<ArtifactRetentionCleanupJobResult> {
  const expiresAt = new Date(options.now.getTime() + 5 * 60 * 1_000);
  const leased = await options.repository.claimArtifactCleanupLease({
    owner: options.owner,
    now: isoTimestamp(options.now.toISOString()),
    expiresAt: isoTimestamp(expiresAt.toISOString()),
  });
  if (!leased) return { skipped: true, inspected: 0, deleted: 0, failed: 0 };
  const limit = options.limit ?? 25;
  const clock = options.clock ?? (() => new Date());
  const deadline = options.now.getTime() + (options.timeBudgetMs ?? 4 * 60_000);
  let inspected = 0;
  let deleted = 0;
  let failed = 0;
  let firstBatch = true;
  while (firstBatch || clock().getTime() < deadline) {
    if (!firstBatch) {
      const heartbeatAt = clock();
      const renewed = await options.repository.renewArtifactCleanupLease({
        owner: options.owner,
        now: isoTimestamp(heartbeatAt.toISOString()),
        expiresAt: isoTimestamp(
          new Date(heartbeatAt.getTime() + 5 * 60_000).toISOString(),
        ),
      });
      if (!renewed) break;
    }
    firstBatch = false;
    const batch = await cleanupExpiredArtifacts({
      manifest: options.manifest,
      admin: options.admin,
      now: options.now,
      limit,
      concurrency: 4,
    });
    inspected += batch.inspected;
    deleted += batch.deleted;
    failed += batch.failed;
    if (batch.inspected < limit || batch.deleted === 0) break;
  }
  return { skipped: false, inspected, deleted, failed };
}
