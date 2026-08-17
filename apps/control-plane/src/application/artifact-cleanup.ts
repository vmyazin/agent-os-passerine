import { cleanupExpiredArtifacts } from '@agentos/adapters';
import {
  isoTimestamp,
  type ArtifactAdminStore,
  type ArtifactManifestStore,
  type DomainRepository,
} from '@agentos/core';

export const ARTIFACT_RETENTION_CLEANUP_POLICY = Object.freeze({
  pageLimit: 25,
  leaseDurationMs: 5 * 60_000,
  timeBudgetMs: 4 * 60_000,
  safetyMarginMs: 30_000,
});

export interface ArtifactRetentionCleanupJobOptions {
  readonly repository: DomainRepository;
  readonly manifest: ArtifactManifestStore;
  readonly admin: ArtifactAdminStore;
  readonly owner: string;
  readonly now: Date;
  readonly limit?: number;
  readonly clock?: () => Date;
  readonly timeBudgetMs?: number;
  readonly safetyMarginMs?: number;
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
  const limit = options.limit ?? ARTIFACT_RETENTION_CLEANUP_POLICY.pageLimit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ARTIFACT_RETENTION_CLEANUP_POLICY.pageLimit
  )
    throw new Error('Artifact cleanup limit must be between 1 and 25');
  const leaseDurationMs = ARTIFACT_RETENTION_CLEANUP_POLICY.leaseDurationMs;
  const timeBudgetMs =
    options.timeBudgetMs ?? ARTIFACT_RETENTION_CLEANUP_POLICY.timeBudgetMs;
  const safetyMarginMs =
    options.safetyMarginMs ?? ARTIFACT_RETENTION_CLEANUP_POLICY.safetyMarginMs;
  if (
    !Number.isSafeInteger(timeBudgetMs) ||
    !Number.isSafeInteger(safetyMarginMs) ||
    safetyMarginMs < 1 ||
    timeBudgetMs <= safetyMarginMs ||
    timeBudgetMs >= leaseDurationMs
  )
    throw new Error('Artifact cleanup time budget is invalid');
  const expiresAt = new Date(options.now.getTime() + leaseDurationMs);
  const leased = await options.repository.claimArtifactCleanupLease({
    owner: options.owner,
    now: isoTimestamp(options.now.toISOString()),
    expiresAt: isoTimestamp(expiresAt.toISOString()),
  });
  if (!leased) return { skipped: true, inspected: 0, deleted: 0, failed: 0 };
  const clock = options.clock ?? (() => new Date());
  const deadline = options.now.getTime() + timeBudgetMs;
  let groupTimeout: ReturnType<typeof setTimeout> | undefined;
  const renewAt = async (at: Date): Promise<boolean> =>
    options.repository.renewArtifactCleanupLease({
      owner: options.owner,
      now: isoTimestamp(at.toISOString()),
      expiresAt: isoTimestamp(
        new Date(at.getTime() + leaseDurationMs).toISOString(),
      ),
    });
  const startGroup = async (): Promise<AbortSignal | false> => {
    const at = clock();
    const remainingBudget = deadline - at.getTime();
    if (remainingBudget <= safetyMarginMs || !(await renewAt(at))) return false;
    const controller = new AbortController();
    groupTimeout = setTimeout(
      () => controller.abort(),
      Math.min(
        remainingBudget - safetyMarginMs,
        leaseDurationMs - safetyMarginMs,
      ),
    );
    groupTimeout.unref?.();
    return controller.signal;
  };
  const finishGroup = async (): Promise<boolean> => {
    if (groupTimeout !== undefined) clearTimeout(groupTimeout);
    groupTimeout = undefined;
    const at = clock();
    return at.getTime() < deadline - safetyMarginMs && (await renewAt(at));
  };
  let inspected = 0;
  let deleted = 0;
  let failed = 0;
  while (clock().getTime() < deadline - safetyMarginMs) {
    const batch = await cleanupExpiredArtifacts({
      manifest: options.manifest,
      admin: options.admin,
      now: options.now,
      limit,
      concurrency: 4,
      startGroup,
      finishGroup,
    });
    inspected += batch.inspected;
    deleted += batch.deleted;
    failed += batch.failed;
    if (batch.stopped || batch.inspected < limit || batch.deleted === 0) break;
  }
  if (groupTimeout !== undefined) clearTimeout(groupTimeout);
  return { skipped: false, inspected, deleted, failed };
}
