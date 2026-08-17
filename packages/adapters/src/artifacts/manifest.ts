import { createHash } from 'node:crypto';

import {
  ArtifactValidationError,
  artifactKeyMatchesScope,
  artifactLogicalKey,
  normalizeArtifactScope,
  parseArtifactKey,
  persistenceId,
  isoTimestamp,
  validateArtifactMetadata,
  type ArtifactAdminStore,
  type ArtifactDeletionAudit,
  type ArtifactManifestListRequest,
  type ArtifactManifestStore,
  type ArtifactMetadata,
  type ArtifactRecord,
  type ArtifactScope,
  type DomainRepository,
} from '@agentos/core';

import { ArtifactStoreAdapterError } from './errors.js';

function conflict(): ArtifactStoreAdapterError {
  return new ArtifactStoreAdapterError(
    'artifact_conflict',
    'artifact version already exists with different content or metadata',
    409,
  );
}

function equivalent(left: ArtifactMetadata, right: ArtifactMetadata): boolean {
  return (
    left.key === right.key &&
    left.digest === right.digest &&
    left.mediaType === right.mediaType &&
    left.sizeBytes === right.sizeBytes &&
    left.retentionClass === right.retentionClass
  );
}

function logicalKey(metadata: ArtifactMetadata): string {
  return artifactLogicalKey(metadata);
}

function recordId(metadata: ArtifactMetadata): string {
  return `artifact_${createHash('sha256')
    .update(`${metadata.projectId}\0${metadata.runId}\0${logicalKey(metadata)}`)
    .digest('hex')}`;
}

function metadataFromRecord(record: ArtifactRecord): ArtifactMetadata {
  if (
    record.uri === undefined ||
    record.mediaType === undefined ||
    record.sizeBytes === undefined ||
    record.cleanupAt === undefined ||
    record.retentionClass === undefined
  )
    throw new ArtifactStoreAdapterError(
      'artifact_integrity_error',
      'artifact manifest is incomplete',
      500,
    );
  const parts = parseArtifactKey(record.uri);
  return validateArtifactMetadata({
    ...parts,
    key: record.uri,
    mediaType: record.mediaType,
    sizeBytes: record.sizeBytes,
    retentionClass: record.retentionClass,
    createdAt: record.createdAt,
    expiresAt: record.cleanupAt,
  });
}

function recordFromMetadata(metadata: ArtifactMetadata): ArtifactRecord {
  validateArtifactMetadata(metadata);
  return {
    id: persistenceId('artifact', recordId(metadata)),
    runId: persistenceId('run', metadata.runId),
    key: logicalKey(metadata),
    mediaType: metadata.mediaType,
    sizeBytes: metadata.sizeBytes,
    digest: metadata.digest,
    uri: metadata.key,
    retentionClass: metadata.retentionClass,
    createdAt: isoTimestamp(metadata.createdAt),
    cleanupAt: isoTimestamp(metadata.expiresAt),
  };
}

function logicalPrefix(request: ArtifactManifestListRequest): string {
  const scope = normalizeArtifactScope(request.scope);
  return `artifact-manifest/v1/${scope.stepId}/${request.artifactPrefix ?? ''}`;
}

function logicalAfter(
  scope: ArtifactScope,
  after: string | undefined,
): string | undefined {
  if (after === undefined) return undefined;
  if (!artifactKeyMatchesScope(after, scope))
    throw new ArtifactValidationError(
      'artifact cursor is outside the requested scope',
    );
  return artifactLogicalKey(parseArtifactKey(after));
}

export function createDomainArtifactManifestStore(
  repository: DomainRepository,
): ArtifactManifestStore {
  return Object.freeze({
    async claim(input: ArtifactMetadata) {
      const metadata = validateArtifactMetadata(input);
      const run = await repository.getRun(persistenceId('run', metadata.runId));
      if (run === undefined || run.projectId !== metadata.projectId)
        throw new ArtifactStoreAdapterError(
          'artifact_scope_denied',
          'artifact run is outside the requested project',
          403,
        );
      const claimed = metadataFromRecord(
        await repository.claimArtifact(recordFromMetadata(metadata)),
      );
      if (!equivalent(claimed, metadata)) throw conflict();
      return claimed;
    },
    async get(scope: ArtifactScope, key: string) {
      const normalized = normalizeArtifactScope(scope);
      if (!artifactKeyMatchesScope(key, normalized))
        throw new ArtifactStoreAdapterError(
          'artifact_scope_denied',
          'artifact is outside the requested scope',
          403,
        );
      const parts = parseArtifactKey(key);
      const record = await repository.getArtifactByRunKey(
        persistenceId('run', normalized.runId),
        artifactLogicalKey(parts),
      );
      if (record === undefined || record.deletedAt !== undefined)
        return undefined;
      const metadata = metadataFromRecord(record);
      if (
        metadata.projectId !== normalized.projectId ||
        metadata.stepId !== normalized.stepId
      )
        throw new ArtifactStoreAdapterError(
          'artifact_integrity_error',
          'artifact manifest scope failed integrity verification',
          500,
        );
      return metadata;
    },
    async list(request: ArtifactManifestListRequest) {
      const normalized = normalizeArtifactScope(request.scope);
      const records = await repository.listArtifactsByRunKey(
        persistenceId('run', normalized.runId),
        logicalPrefix(request),
        logicalAfter(normalized, request.after),
        request.limit + 1,
      );
      const page = records.slice(0, request.limit);
      const items = page.map(metadataFromRecord).filter((metadata) => {
        if (
          metadata.projectId !== normalized.projectId ||
          metadata.stepId !== normalized.stepId
        )
          throw new ArtifactStoreAdapterError(
            'artifact_integrity_error',
            'artifact manifest scope failed integrity verification',
            500,
          );
        return (
          request.artifactPrefix === undefined ||
          metadata.artifactId.startsWith(request.artifactPrefix)
        );
      });
      return Object.freeze({
        items: Object.freeze(items),
        ...(records.length <= request.limit || page.length === 0
          ? {}
          : { nextAfter: metadataFromRecord(page.at(-1)!).key }),
      });
    },
    async listExpired(before: string, limit: number) {
      const records = await repository.listArtifactsDueForCleanup(
        isoTimestamp(before),
        limit,
      );
      return Object.freeze(records.map(metadataFromRecord));
    },
    async markDeleted(audit: ArtifactDeletionAudit) {
      const parts = parseArtifactKey(audit.key);
      const record = await repository.getArtifactByRunKey(
        persistenceId('run', parts.runId),
        artifactLogicalKey(parts),
      );
      if (record === undefined) return;
      await repository.markArtifactDeleted(
        record.id,
        isoTimestamp(audit.deletedAt),
        audit.reason,
      );
    },
  });
}

export function createInMemoryArtifactManifestStore(): ArtifactManifestStore {
  const values = new Map<string, ArtifactMetadata>();
  const deleted = new Set<string>();
  const identity = (metadata: ArtifactMetadata) =>
    `${metadata.projectId}\0${metadata.runId}\0${logicalKey(metadata)}`;
  return Object.freeze({
    async claim(input: ArtifactMetadata) {
      const metadata = validateArtifactMetadata(input);
      const id = identity(metadata);
      const existing = values.get(id);
      if (existing !== undefined) {
        if (!equivalent(existing, metadata)) throw conflict();
        return existing;
      }
      values.set(id, Object.freeze({ ...metadata }));
      return metadata;
    },
    async get(scope: ArtifactScope, key: string) {
      if (!artifactKeyMatchesScope(key, scope))
        throw new ArtifactStoreAdapterError(
          'artifact_scope_denied',
          'artifact is outside the requested scope',
          403,
        );
      const parts = parseArtifactKey(key);
      const value = values.get(
        `${parts.projectId}\0${parts.runId}\0${artifactLogicalKey(parts)}`,
      );
      return value === undefined || deleted.has(value.key) ? undefined : value;
    },
    async list(request: ArtifactManifestListRequest) {
      const normalized = normalizeArtifactScope(request.scope);
      const after = request.after;
      const matching = [...values.values()]
        .filter(
          (metadata) =>
            !deleted.has(metadata.key) &&
            metadata.projectId === normalized.projectId &&
            metadata.runId === normalized.runId &&
            metadata.stepId === normalized.stepId &&
            (request.artifactPrefix === undefined ||
              metadata.artifactId.startsWith(request.artifactPrefix)) &&
            (after === undefined || metadata.key > after),
        )
        .sort((left, right) =>
          left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
        );
      const page = matching.slice(0, request.limit);
      return Object.freeze({
        items: Object.freeze(page),
        ...(matching.length <= request.limit || page.length === 0
          ? {}
          : { nextAfter: page.at(-1)!.key }),
      });
    },
    async listExpired(before: string, limit: number) {
      return Object.freeze(
        [...values.values()]
          .filter(
            (value) => !deleted.has(value.key) && value.expiresAt <= before,
          )
          .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
          .slice(0, limit),
      );
    },
    async markDeleted(audit: ArtifactDeletionAudit) {
      deleted.add(audit.key);
    },
  });
}

export interface ArtifactRetentionCleanupResult {
  readonly inspected: number;
  readonly deleted: number;
}

export async function cleanupExpiredArtifacts(options: {
  readonly manifest: ArtifactManifestStore;
  readonly admin: ArtifactAdminStore;
  readonly now: Date;
  readonly limit?: number;
}): Promise<ArtifactRetentionCleanupResult> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    throw new Error('Artifact cleanup limit is invalid');
  const deletedAt = options.now.toISOString();
  const expired = await options.manifest.listExpired(deletedAt, limit);
  let deleted = 0;
  for (const metadata of expired) {
    if (
      await options.admin.delete(metadata.key, {
        deletedAt,
        reason: 'retention_expired',
      })
    )
      deleted += 1;
    await options.manifest.markDeleted({
      key: metadata.key,
      deletedAt,
      reason: 'retention_expired',
    });
  }
  return Object.freeze({ inspected: expired.length, deleted });
}
