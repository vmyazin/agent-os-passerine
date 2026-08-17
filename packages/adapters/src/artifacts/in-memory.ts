import { createHash } from 'node:crypto';

import {
  ArtifactValidationError,
  artifactKeyMatchesScope,
  normalizeArtifactListRequest,
  parseArtifactKey,
  prepareArtifactPut,
  type ArtifactAdminStore,
  type ArtifactDeletionAudit,
  type ArtifactGetRequest,
  type ArtifactListRequest,
  type ArtifactMetadata,
  type ArtifactManifestStore,
  type ArtifactPutRequest,
  type ArtifactStore,
  type ArtifactValue,
} from '@agentos/core';

import { createArtifactCursorCodec, type ArtifactCursorKey } from './cursor.js';
import { ArtifactStoreAdapterError } from './errors.js';
import { createInMemoryArtifactManifestStore } from './manifest.js';

interface Stored {
  readonly metadata: ArtifactMetadata;
  readonly bytes: Uint8Array;
}

export interface InMemoryArtifactStorageOptions {
  readonly now?: () => Date;
  readonly maxBytes?: number;
  readonly cursorKeys?: readonly ArtifactCursorKey[];
  readonly manifest?: ArtifactManifestStore;
}

function metadata(value: ArtifactValue): ArtifactMetadata {
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

function scopeError(): ArtifactStoreAdapterError {
  return new ArtifactStoreAdapterError(
    'artifact_scope_denied',
    'artifact is outside the requested scope',
    403,
  );
}

export function createInMemoryArtifactStorage(
  options: InMemoryArtifactStorageOptions = {},
): {
  readonly store: ArtifactStore;
  readonly admin: ArtifactAdminStore;
  readonly manifest: ArtifactManifestStore;
} {
  const values = new Map<string, Stored>();
  const manifest = options.manifest ?? createInMemoryArtifactManifestStore();
  const now = options.now ?? (() => new Date());
  const cursors = createArtifactCursorCodec({
    ...(options.cursorKeys === undefined ? {} : { keys: options.cursorKeys }),
  });
  const store: ArtifactStore = Object.freeze({
    async put(request: ArtifactPutRequest) {
      const prepared = prepareArtifactPut(request, now(), {
        ...(options.maxBytes === undefined
          ? {}
          : { maxBytes: options.maxBytes }),
      });
      const claimed = await manifest.claim(metadata(prepared));
      if (claimed.key !== prepared.key)
        throw new ArtifactStoreAdapterError(
          'artifact_conflict',
          'artifact version already exists with different content',
          409,
        );
      const existing = values.get(prepared.key);
      if (existing !== undefined) {
        if (
          existing.metadata.mediaType !== prepared.mediaType ||
          existing.metadata.retentionClass !== prepared.retentionClass ||
          existing.metadata.digest !== prepared.digest
        )
          throw new ArtifactStoreAdapterError(
            'artifact_conflict',
            'artifact key already exists with different metadata',
            409,
          );
        return existing.metadata;
      }
      const stored = {
        metadata: metadata(prepared),
        bytes: Uint8Array.from(prepared.bytes),
      };
      values.set(prepared.key, stored);
      return stored.metadata;
    },
    async get(request: ArtifactGetRequest) {
      let inScope: boolean;
      try {
        inScope = artifactKeyMatchesScope(request.key, request.scope);
      } catch (error) {
        if (error instanceof ArtifactValidationError) throw error;
        throw scopeError();
      }
      if (!inScope) throw scopeError();
      const claimed = await manifest.get(request.scope, request.key);
      if (claimed === undefined) return undefined;
      const stored = values.get(request.key);
      if (stored === undefined)
        throw new ArtifactStoreAdapterError(
          'artifact_integrity_error',
          'artifact manifest references a missing object',
          500,
        );
      if (
        request.maxBytes !== undefined &&
        stored.bytes.byteLength > request.maxBytes
      )
        throw new ArtifactStoreAdapterError(
          'artifact_too_large',
          'artifact exceeds read limit',
          413,
        );
      const digest = createHash('sha256').update(stored.bytes).digest('hex');
      if (digest !== stored.metadata.digest)
        throw new ArtifactStoreAdapterError(
          'artifact_integrity_error',
          'artifact failed integrity verification',
          500,
        );
      return Object.freeze({
        ...stored.metadata,
        bytes: Uint8Array.from(stored.bytes),
      });
    },
    async list(input: ArtifactListRequest) {
      const request = normalizeArtifactListRequest(input);
      const cursorQuery = {
        scope: request.scope,
        ...(request.artifactPrefix === undefined
          ? {}
          : { artifactPrefix: request.artifactPrefix }),
        limit: request.limit!,
      };
      const after = cursors.decode(cursorQuery, request.cursor);
      const limit = request.limit!;
      const page = await manifest.list({
        scope: request.scope,
        ...(request.artifactPrefix === undefined
          ? {}
          : { artifactPrefix: request.artifactPrefix }),
        ...(after === undefined ? {} : { after }),
        limit,
      });
      return Object.freeze({
        items: page.items,
        ...(page.nextAfter === undefined
          ? {}
          : { nextCursor: cursors.encode(cursorQuery, page.nextAfter) }),
      });
    },
  });
  const admin: ArtifactAdminStore = Object.freeze({
    async delete(key: string, audit?: Omit<ArtifactDeletionAudit, 'key'>) {
      parseArtifactKey(key);
      const removed = values.delete(key);
      await manifest.markDeleted({
        key,
        deletedAt: audit?.deletedAt ?? now().toISOString(),
        reason: audit?.reason ?? 'control_plane_delete',
      });
      return removed;
    },
  });
  return Object.freeze({ store, admin, manifest });
}
