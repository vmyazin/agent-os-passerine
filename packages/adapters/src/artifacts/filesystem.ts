import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import {
  ArtifactValidationError,
  artifactKeyMatchesScope,
  normalizeArtifactListRequest,
  parseArtifactKey,
  prepareArtifactPut,
  type ArtifactAdminStore,
  type ArtifactDeletionAudit,
  type ArtifactGetRequest,
  type ArtifactKeyParts,
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

export interface FilesystemArtifactStorageOptions {
  readonly root: string;
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

function conflictError(message: string): ArtifactStoreAdapterError {
  return new ArtifactStoreAdapterError('artifact_conflict', message, 409);
}

function integrityError(message: string): ArtifactStoreAdapterError {
  return new ArtifactStoreAdapterError(
    'artifact_integrity_error',
    message,
    500,
  );
}

function unavailable(error: unknown): never {
  if (
    error instanceof ArtifactValidationError ||
    error instanceof ArtifactStoreAdapterError
  )
    throw error;
  throw new ArtifactStoreAdapterError(
    'artifact_store_unavailable',
    'artifact storage is unavailable',
    503,
  );
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Scope identifiers reach this store already validated as canonical segments,
 * so this guard is a second lock on the door: nothing that could escape the
 * root ever reaches the filesystem.
 */
function pathSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  )
    throw new ArtifactStoreAdapterError(
      'invalid_artifact',
      `${label} is not a safe path segment`,
      400,
    );
  return value;
}

function bodyPath(root: string, parts: ArtifactKeyParts): string {
  return join(
    root,
    'artifacts',
    'v1',
    pathSegment(parts.projectId, 'projectId'),
    pathSegment(parts.runId, 'runId'),
    pathSegment(parts.stepId, 'stepId'),
    pathSegment(parts.artifactId, 'artifactId'),
    pathSegment(`${parts.version}-${parts.digest}`, 'body'),
  );
}

async function bodySize(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if (missing(error)) return undefined;
    return unavailable(error);
  }
}

async function readBody(file: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(file));
  } catch (error) {
    if (missing(error)) return undefined;
    return unavailable(error);
  }
}

async function writeBody(file: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(file);
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    unavailable(error);
  }
}

async function removeBody(file: string): Promise<void> {
  try {
    await rm(file, { force: true });
  } catch (error) {
    unavailable(error);
  }
}

export function createFilesystemArtifactStorage(
  options: FilesystemArtifactStorageOptions,
): {
  readonly store: ArtifactStore;
  readonly admin: ArtifactAdminStore;
  readonly manifest: ArtifactManifestStore;
} {
  const root = options.root;
  if (root.length === 0 || !isAbsolute(root))
    throw new Error('filesystem artifact root must be an absolute path');
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
      const file = bodyPath(root, prepared);
      const leaseId = randomUUID();
      const leaseNow = now();
      const claimed = await manifest.beginWrite(metadata(prepared), {
        leaseId,
        now: leaseNow.toISOString(),
        expiresAt: new Date(leaseNow.getTime() + 120_000).toISOString(),
      });
      try {
        if (claimed.key !== prepared.key)
          throw conflictError(
            'artifact version already exists with different content',
          );
        if (
          claimed.mediaType !== prepared.mediaType ||
          claimed.retentionClass !== prepared.retentionClass ||
          claimed.digest !== prepared.digest
        )
          throw conflictError(
            'artifact key already exists with different metadata',
          );
        if ((await bodySize(file)) !== undefined) return claimed;
        await writeBody(file, prepared.bytes);
        return claimed;
      } finally {
        await manifest.finishWrite(claimed, leaseId);
      }
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
      const file = bodyPath(root, parseArtifactKey(request.key));
      const size = await bodySize(file);
      if (size === undefined)
        throw integrityError('artifact manifest references a missing object');
      if (request.maxBytes !== undefined && size > request.maxBytes)
        throw new ArtifactStoreAdapterError(
          'artifact_too_large',
          'artifact exceeds read limit',
          413,
        );
      const bytes = await readBody(file);
      if (bytes === undefined)
        throw integrityError('artifact manifest references a missing object');
      if (
        bytes.byteLength !== claimed.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== claimed.digest
      )
        throw integrityError('artifact failed integrity verification');
      return Object.freeze({ ...claimed, bytes });
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
    async delete(
      key: string,
      audit?: Omit<ArtifactDeletionAudit, 'key'>,
      operation?: { readonly signal?: AbortSignal },
    ) {
      if (operation?.signal?.aborted)
        throw new ArtifactStoreAdapterError(
          'artifact_store_unavailable',
          'artifact deletion was cancelled',
          503,
        );
      const parts = parseArtifactKey(key);
      const file = bodyPath(root, parts);
      const reservationTime = now().toISOString();
      const deletedAt = audit?.deletedAt ?? reservationTime;
      const deletionAudit = {
        key,
        deletedAt,
        reason: audit?.reason ?? 'control_plane_delete',
      };
      const expected = await manifest.reserveDeletion(
        parts,
        key,
        deletionAudit,
        reservationTime,
      );
      if (expected === undefined) return false;
      await removeBody(file);
      await manifest.finalizeDeletion(expected, deletionAudit);
      return true;
    },
  });
  return Object.freeze({ store, admin, manifest });
}
