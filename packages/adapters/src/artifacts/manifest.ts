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
  type ArtifactWriteLease,
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

function deleted(): ArtifactStoreAdapterError {
  return new ArtifactStoreAdapterError(
    'artifact_deleted',
    'artifact logical version has been deleted and cannot be recreated',
    410,
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

function exactlyEquivalent(
  left: ArtifactMetadata,
  right: ArtifactMetadata,
): boolean {
  return (
    equivalent(left, right) &&
    left.projectId === right.projectId &&
    left.runId === right.runId &&
    left.stepId === right.stepId &&
    left.artifactId === right.artifactId &&
    left.version === right.version &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt
  );
}

function logicalKey(metadata: ArtifactMetadata): string {
  return artifactLogicalKey(metadata);
}

function metadataOnly(value: ArtifactMetadata): ArtifactMetadata {
  return Object.freeze({
    key: value.key,
    projectId: value.projectId,
    runId: value.runId,
    stepId: value.stepId,
    artifactId: value.artifactId,
    version: value.version,
    digest: value.digest,
    mediaType: value.mediaType,
    sizeBytes: value.sizeBytes,
    retentionClass: value.retentionClass,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  });
}

function recordId(metadata: ArtifactMetadata): string {
  return `artifact_${createHash('sha256')
    .update(`${metadata.projectId}\0${metadata.runId}\0${logicalKey(metadata)}`)
    .digest('hex')}`;
}

function metadataFromRecord(record: ArtifactRecord): ArtifactMetadata {
  if (
    record.manifestVersion !== 'artifact-manifest-v1' ||
    record.uri === undefined ||
    record.mediaType === undefined ||
    record.sizeBytes === undefined ||
    record.cleanupAt === undefined ||
    record.retentionClass === undefined ||
    !['active', 'pending', 'deleted'].includes(record.deletionState ?? '')
  )
    throw new ArtifactStoreAdapterError(
      'artifact_integrity_error',
      'artifact manifest is incomplete',
      500,
    );
  const parts = parseArtifactKey(record.uri);
  const metadata = validateArtifactMetadata({
    ...parts,
    key: record.uri,
    mediaType: record.mediaType,
    sizeBytes: record.sizeBytes,
    retentionClass: record.retentionClass,
    createdAt: record.createdAt,
    expiresAt: record.cleanupAt,
  });
  if (
    record.runId !== metadata.runId ||
    record.key !== logicalKey(metadata) ||
    record.digest !== metadata.digest ||
    record.id !== persistenceId('artifact', recordId(metadata))
  )
    throw new ArtifactStoreAdapterError(
      'artifact_integrity_error',
      'artifact manifest identity failed integrity verification',
      500,
    );
  return metadata;
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
    manifestVersion: 'artifact-manifest-v1',
    deletionState: 'active',
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
      const record = await repository.claimArtifact(
        recordFromMetadata(metadata),
      );
      if (
        record.deletedAt !== undefined ||
        record.deletionState === 'pending' ||
        record.deletionState === 'deleted'
      )
        throw deleted();
      const claimed = metadataFromRecord(record);
      if (!equivalent(claimed, metadata)) throw conflict();
      return claimed;
    },
    async beginWrite(input: ArtifactMetadata, lease: ArtifactWriteLease) {
      const metadata = validateArtifactMetadata(input);
      const run = await repository.getRun(persistenceId('run', metadata.runId));
      if (run === undefined || run.projectId !== metadata.projectId)
        throw new ArtifactStoreAdapterError(
          'artifact_scope_denied',
          'artifact run is outside the requested project',
          403,
        );
      const existing = await repository.getArtifactByRunKey(
        persistenceId('run', metadata.runId),
        logicalKey(metadata),
      );
      let authoritative = metadata;
      if (existing !== undefined) {
        if (
          existing.deletedAt !== undefined ||
          existing.deletionState === 'pending' ||
          existing.deletionState === 'deleted'
        )
          throw deleted();
        authoritative = metadataFromRecord(existing);
        if (!equivalent(authoritative, metadata)) throw conflict();
      }
      const record = await repository.claimArtifactForWrite({
        artifact: recordFromMetadata(authoritative),
        leaseId: lease.leaseId,
        now: isoTimestamp(lease.now),
        expiresAt: isoTimestamp(lease.expiresAt),
      });
      if (
        record.deletedAt !== undefined ||
        record.deletionState === 'pending' ||
        record.deletionState === 'deleted'
      )
        throw deleted();
      const claimed = metadataFromRecord(record);
      if (!equivalent(claimed, authoritative)) throw conflict();
      if (record.writeLeaseId !== lease.leaseId) throw conflict();
      return claimed;
    },
    async finishWrite(expected: ArtifactMetadata, leaseId: string) {
      await repository.releaseArtifactWriteLease(
        persistenceId('artifact', recordId(expected)),
        leaseId,
      );
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
      if (
        record === undefined ||
        record.deletedAt !== undefined ||
        record.deletionState === 'pending' ||
        record.deletionState === 'deleted'
      )
        return undefined;
      const metadata = metadataFromRecord(record);
      if (
        metadata.key !== key ||
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
      const items: ArtifactMetadata[] = [];
      let invalidCount = 0;
      for (const record of records) {
        try {
          items.push(metadataFromRecord(record));
        } catch {
          invalidCount += 1;
        }
      }
      return Object.freeze({ items: Object.freeze(items), invalidCount });
    },
    async reserveDeletion(
      scope: ArtifactScope,
      key: string,
      audit: ArtifactDeletionAudit,
      reservationTime: string,
    ) {
      const normalized = normalizeArtifactScope(scope);
      if (audit.key !== key || !artifactKeyMatchesScope(key, normalized))
        throw new ArtifactStoreAdapterError(
          'artifact_integrity_error',
          'artifact deletion target failed integrity verification',
          409,
        );
      const parts = parseArtifactKey(key);
      const record = await repository.getArtifactByRunKey(
        persistenceId('run', normalized.runId),
        artifactLogicalKey(parts),
      );
      if (record === undefined || record.deletionState === 'deleted')
        return undefined;
      const actual = metadataFromRecord(record);
      if (actual.key !== key) return undefined;
      if (!artifactKeyMatchesScope(actual.key, normalized)) throw conflict();
      const reserved = await repository.reserveArtifactDeletion({
        id: record.id,
        runId: record.runId,
        logicalKey: record.key,
        uri: actual.key,
        digest: actual.digest,
        now: isoTimestamp(reservationTime),
        requestedAt: isoTimestamp(reservationTime),
        reason: audit.reason,
      });
      if (reserved === undefined) return undefined;
      const reservedMetadata = metadataFromRecord(reserved);
      if (!exactlyEquivalent(reservedMetadata, actual)) throw conflict();
      return reservedMetadata;
    },
    async finalizeDeletion(
      expected: ArtifactMetadata,
      audit: ArtifactDeletionAudit,
    ) {
      if (audit.key !== expected.key)
        throw new ArtifactStoreAdapterError(
          'artifact_integrity_error',
          'artifact deletion target failed integrity verification',
          409,
        );
      const parts = parseArtifactKey(expected.key);
      const record = await repository.getArtifactByRunKey(
        persistenceId('run', parts.runId),
        artifactLogicalKey(parts),
      );
      if (record === undefined) return;
      const actual = metadataFromRecord(record);
      if (!exactlyEquivalent(actual, expected)) throw conflict();
      await repository.finalizeArtifactDeletion({
        id: record.id,
        runId: record.runId,
        logicalKey: record.key,
        uri: actual.key,
        digest: actual.digest,
        deletedAt: isoTimestamp(audit.deletedAt),
        reason: audit.reason,
      });
    },
  });
}

export function createInMemoryArtifactManifestStore(): ArtifactManifestStore {
  const values = new Map<string, ArtifactMetadata>();
  const tombstones = new Set<string>();
  const pending = new Set<string>();
  const writeLeases = new Map<string, ArtifactWriteLease>();
  const identity = (metadata: ArtifactMetadata) =>
    `${metadata.projectId}\0${metadata.runId}\0${logicalKey(metadata)}`;
  return Object.freeze({
    async claim(input: ArtifactMetadata) {
      const metadata = validateArtifactMetadata(input);
      const id = identity(metadata);
      if (tombstones.has(id) || pending.has(id)) throw deleted();
      const existing = values.get(id);
      if (existing !== undefined) {
        if (!equivalent(existing, metadata)) throw conflict();
        return existing;
      }
      const stored = metadataOnly(metadata);
      values.set(id, stored);
      return stored;
    },
    async beginWrite(input: ArtifactMetadata, lease: ArtifactWriteLease) {
      const metadata = validateArtifactMetadata(input);
      const id = identity(metadata);
      if (tombstones.has(id) || pending.has(id)) throw deleted();
      const currentLease = writeLeases.get(id);
      if (
        currentLease !== undefined &&
        currentLease.leaseId !== lease.leaseId &&
        currentLease.expiresAt > lease.now
      )
        throw conflict();
      const existing = values.get(id);
      if (existing !== undefined && !equivalent(existing, metadata))
        throw conflict();
      const stored = existing ?? metadataOnly(metadata);
      values.set(id, stored);
      writeLeases.set(id, Object.freeze({ ...lease }));
      return stored;
    },
    async finishWrite(expected: ArtifactMetadata, leaseId: string) {
      const id = identity(expected);
      if (writeLeases.get(id)?.leaseId === leaseId) writeLeases.delete(id);
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
      if (
        value === undefined ||
        tombstones.has(identity(value)) ||
        pending.has(identity(value))
      )
        return undefined;
      return value.key === key ? value : undefined;
    },
    async list(request: ArtifactManifestListRequest) {
      const normalized = normalizeArtifactScope(request.scope);
      const after = request.after;
      const matching = [...values.values()]
        .filter(
          (metadata) =>
            !tombstones.has(identity(metadata)) &&
            !pending.has(identity(metadata)) &&
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
      return Object.freeze({
        items: Object.freeze(
          [...values.values()]
            .filter(
              (value) =>
                !tombstones.has(identity(value)) && value.expiresAt <= before,
            )
            .sort((left, right) =>
              left.expiresAt.localeCompare(right.expiresAt),
            )
            .slice(0, limit),
        ),
        invalidCount: 0,
      });
    },
    async reserveDeletion(
      scope: ArtifactScope,
      key: string,
      audit: ArtifactDeletionAudit,
      reservationTime: string,
    ) {
      if (audit.key !== key || !artifactKeyMatchesScope(key, scope))
        throw conflict();
      const parts = parseArtifactKey(key);
      const id = `${parts.projectId}\0${parts.runId}\0${artifactLogicalKey(parts)}`;
      if (tombstones.has(id)) return undefined;
      const existing = values.get(id);
      if (existing === undefined || existing.key !== key) return undefined;
      const lease = writeLeases.get(id);
      if (lease !== undefined && lease.expiresAt > reservationTime)
        return undefined;
      pending.add(id);
      return existing;
    },
    async finalizeDeletion(
      expected: ArtifactMetadata,
      audit: ArtifactDeletionAudit,
    ) {
      if (audit.key !== expected.key) throw conflict();
      const existing = values.get(identity(expected));
      if (existing === undefined || !exactlyEquivalent(existing, expected))
        throw conflict();
      if (!pending.has(identity(expected))) throw conflict();
      pending.delete(identity(expected));
      tombstones.add(identity(expected));
    },
  });
}

export interface ArtifactRetentionCleanupResult {
  readonly inspected: number;
  readonly deleted: number;
  readonly failed: number;
  readonly stopped?: true;
}

export async function cleanupExpiredArtifacts(options: {
  readonly manifest: ArtifactManifestStore;
  readonly admin: ArtifactAdminStore;
  readonly now: Date;
  readonly limit?: number;
  readonly concurrency?: number;
  readonly startGroup?: () => Promise<AbortSignal | false>;
  readonly finishGroup?: () => Promise<boolean>;
}): Promise<ArtifactRetentionCleanupResult> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    throw new Error('Artifact cleanup limit is invalid');
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('Artifact cleanup concurrency is invalid');
  const deletedAt = options.now.toISOString();
  const expired = await options.manifest.listExpired(deletedAt, limit);
  let deleted = 0;
  let failed = expired.invalidCount;
  let inspected = expired.invalidCount;
  let stopped = false;
  for (let offset = 0; offset < expired.items.length; offset += concurrency) {
    const signal = (await options.startGroup?.()) ?? undefined;
    if (signal === false) {
      stopped = true;
      break;
    }
    const group = expired.items.slice(offset, offset + concurrency);
    const results = await Promise.all(
      group.map(async (metadata) => {
        try {
          return await options.admin.delete(
            metadata.key,
            { deletedAt, reason: 'retention_expired' },
            signal === undefined ? undefined : { signal },
          );
        } catch {
          return false;
        }
      }),
    );
    inspected += group.length;
    for (const removed of results) {
      if (removed) deleted += 1;
      else failed += 1;
    }
    if (options.finishGroup !== undefined && !(await options.finishGroup())) {
      stopped = true;
      break;
    }
  }
  return Object.freeze({
    inspected,
    deleted,
    failed,
    ...(stopped ? { stopped: true as const } : {}),
  });
}
