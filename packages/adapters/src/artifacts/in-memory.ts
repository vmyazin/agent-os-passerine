import { createHash } from 'node:crypto';

import {
  ArtifactValidationError,
  artifactKeyMatchesScope,
  normalizeArtifactListRequest,
  parseArtifactKey,
  prepareArtifactPut,
  type ArtifactAdminStore,
  type ArtifactGetRequest,
  type ArtifactListRequest,
  type ArtifactMetadata,
  type ArtifactPutRequest,
  type ArtifactStore,
  type ArtifactValue,
} from '@agentos/core';

import { decodeArtifactCursor, encodeArtifactCursor } from './cursor.js';
import { ArtifactStoreAdapterError } from './errors.js';

interface Stored {
  readonly metadata: ArtifactMetadata;
  readonly bytes: Uint8Array;
}

export interface InMemoryArtifactStorageOptions {
  readonly now?: () => Date;
  readonly maxBytes?: number;
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
): { readonly store: ArtifactStore; readonly admin: ArtifactAdminStore } {
  const values = new Map<string, Stored>();
  const now = options.now ?? (() => new Date());
  const store: ArtifactStore = Object.freeze({
    async put(request: ArtifactPutRequest) {
      const prepared = prepareArtifactPut(request, now(), {
        ...(options.maxBytes === undefined
          ? {}
          : { maxBytes: options.maxBytes }),
      });
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
      const stored = values.get(request.key);
      if (stored === undefined) return undefined;
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
      const after = decodeArtifactCursor(request.scope, request.cursor);
      const items = [...values.values()]
        .map((value) => value.metadata)
        .filter(
          (value) =>
            artifactKeyMatchesScope(value.key, request.scope) &&
            (request.artifactPrefix === undefined ||
              value.artifactId.startsWith(request.artifactPrefix)) &&
            (after === undefined || value.key > after),
        )
        .sort((left, right) =>
          left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
        );
      const limit = request.limit!;
      const page = items.slice(0, limit);
      return Object.freeze({
        items: Object.freeze(page),
        ...(items.length <= limit || page.length === 0
          ? {}
          : {
              nextCursor: encodeArtifactCursor(request.scope, page.at(-1)!.key),
            }),
      });
    },
  });
  const admin: ArtifactAdminStore = Object.freeze({
    async delete(key: string) {
      parseArtifactKey(key);
      return values.delete(key);
    },
  });
  return Object.freeze({ store, admin });
}
