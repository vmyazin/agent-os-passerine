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
  const result = await cleanupExpiredArtifacts({
    manifest: options.manifest,
    admin: options.admin,
    now: options.now,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return { skipped: false, ...result };
}
