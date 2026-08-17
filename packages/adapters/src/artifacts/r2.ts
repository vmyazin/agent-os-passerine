import { createHash, randomUUID } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type DeleteObjectCommandInput,
  type GetObjectCommandInput,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import {
  DEFAULT_ARTIFACT_MAX_BYTES,
  ArtifactValidationError,
  artifactKeyMatchesScope,
  normalizeArtifactListRequest,
  parseArtifactKey,
  prepareArtifactPut,
  validateArtifactMetadata,
  type ArtifactAdminStore,
  type ArtifactDeletionAudit,
  type ArtifactGetRequest,
  type ArtifactListRequest,
  type ArtifactManifestStore,
  type ArtifactMetadata,
  type ArtifactPutRequest,
  type ArtifactStore,
} from '@agentos/core';

import {
  createArtifactCursorCodec,
  type ArtifactCursorCodec,
  type ArtifactCursorKey,
} from './cursor.js';
import { ArtifactStoreAdapterError } from './errors.js';

export type R2CommandKind = 'PutObject' | 'GetObject' | 'DeleteObject';

export interface R2Command {
  readonly kind: R2CommandKind;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface R2SdkClient {
  send(
    command: R2Command,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
}

export interface R2ArtifactStorageOptions {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly jurisdiction?: 'default' | 'eu' | 'fedramp';
  readonly timeoutMs?: number;
  readonly retryAttempts?: number;
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly cursorKeys?: readonly ArtifactCursorKey[];
  readonly manifest: ArtifactManifestStore;
}

export interface R2ArtifactStorageDependencies {
  readonly client: R2SdkClient;
  readonly bucket: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly retry?: { readonly attempts: number; readonly baseDelayMs: number };
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly cursorCodec?: ArtifactCursorCodec;
  readonly manifest: ArtifactManifestStore;
}

const SAFE_ACCOUNT = /^[a-f0-9]{32}$/;
const SAFE_BUCKET = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/;
const DEFAULT_TIMEOUT_MS = 15_000;

function nonEmpty(value: string, label: string): string {
  if (value.trim() === '') throw new Error(`R2 ${label} is required`);
  return value;
}

function endpoint(options: R2ArtifactStorageOptions): string {
  if ('endpoint' in options)
    throw new Error('R2 endpoint overrides are not allowed');
  if (!SAFE_ACCOUNT.test(options.accountId))
    throw new Error('R2 accountId is invalid');
  const jurisdiction = options.jurisdiction ?? 'default';
  if (!['default', 'eu', 'fedramp'].includes(jurisdiction))
    throw new Error('R2 jurisdiction is invalid');
  return `https://${options.accountId}${
    jurisdiction === 'default' ? '' : `.${jurisdiction}`
  }.r2.cloudflarestorage.com`;
}

class AwsR2Client implements R2SdkClient {
  constructor(private readonly client: S3Client) {}

  async send(
    command: R2Command,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const handlerOptions =
      options?.abortSignal === undefined
        ? undefined
        : { abortSignal: options.abortSignal };
    if (command.kind === 'PutObject')
      return (await this.client.send(
        new PutObjectCommand(command.input as unknown as PutObjectCommandInput),
        handlerOptions,
      )) as unknown as Record<string, unknown>;
    if (command.kind === 'GetObject')
      return (await this.client.send(
        new GetObjectCommand(command.input as unknown as GetObjectCommandInput),
        handlerOptions,
      )) as unknown as Record<string, unknown>;
    return (await this.client.send(
      new DeleteObjectCommand(
        command.input as unknown as DeleteObjectCommandInput,
      ),
      handlerOptions,
    )) as unknown as Record<string, unknown>;
  }
}

function dependenciesFromOptions(
  options: R2ArtifactStorageOptions,
): R2ArtifactStorageDependencies {
  if (
    options.manifest === undefined ||
    typeof options.manifest.beginWrite !== 'function' ||
    typeof options.manifest.finishWrite !== 'function' ||
    typeof options.manifest.get !== 'function' ||
    typeof options.manifest.list !== 'function' ||
    typeof options.manifest.reserveDeletion !== 'function' ||
    typeof options.manifest.finalizeDeletion !== 'function'
  )
    throw new Error('R2 artifact manifest is required');
  const accountEndpoint = endpoint(options);
  if (!SAFE_BUCKET.test(options.bucket))
    throw new Error('R2 bucket is invalid');
  const accessKeyId = nonEmpty(options.accessKeyId, 'accessKeyId');
  const secretAccessKey = nonEmpty(options.secretAccessKey, 'secretAccessKey');
  const client = new S3Client({
    region: 'auto',
    endpoint: accountEndpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    client: new AwsR2Client(client),
    bucket: options.bucket,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
    cursorCodec: createArtifactCursorCodec({
      ...(options.cursorKeys === undefined ? {} : { keys: options.cursorKeys }),
    }),
    manifest: options.manifest,
    retry: { attempts: options.retryAttempts ?? 2, baseDelayMs: 100 },
  };
}

export function createR2ArtifactStore(
  options: R2ArtifactStorageOptions,
): ArtifactStore {
  return createR2ArtifactStorageWithDependencies(
    dependenciesFromOptions(options),
  ).store;
}

export function createR2ArtifactAdminStore(
  options: R2ArtifactStorageOptions,
): ArtifactAdminStore {
  return createR2ArtifactStorageWithDependencies(
    dependenciesFromOptions(options),
  ).admin;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function status(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata;
  return typeof metadata?.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined;
}

function missing(error: unknown): boolean {
  return (
    ['NotFound', 'NoSuchKey', 'NoSuchObject'].includes(errorName(error)) ||
    status(error) === 404
  );
}

function precondition(error: unknown): boolean {
  return (
    ['PreconditionFailed', 'ConditionalRequestConflict'].includes(
      errorName(error),
    ) || [409, 412].includes(status(error) ?? 0)
  );
}

function transient(error: unknown): boolean {
  return (
    [
      'TimeoutError',
      'AbortError',
      'Throttling',
      'SlowDown',
      'ServiceUnavailable',
    ].includes(errorName(error)) || (status(error) ?? 0) >= 500
  );
}

function metadataFromResponse(
  key: string,
  response: Record<string, unknown>,
): ArtifactMetadata {
  const parts = parseArtifactKey(key);
  const raw = response.Metadata;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ArtifactStoreAdapterError(
      'artifact_integrity_error',
      'artifact metadata failed integrity verification',
      500,
    );
  const values = raw as Record<string, unknown>;
  const sizeBytes = response.ContentLength;
  const metadata: ArtifactMetadata = {
    ...parts,
    key,
    mediaType: String(response.ContentType ?? ''),
    sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : Number.NaN,
    retentionClass: String(
      values['retention-class'],
    ) as ArtifactMetadata['retentionClass'],
    createdAt: String(values['created-at'] ?? ''),
    expiresAt: String(values['expires-at'] ?? ''),
  };
  if (values.digest !== parts.digest)
    throw new ArtifactStoreAdapterError(
      'artifact_integrity_error',
      'artifact metadata failed integrity verification',
      500,
    );
  try {
    return validateArtifactMetadata(metadata);
  } catch {
    throw new ArtifactStoreAdapterError(
      'artifact_integrity_error',
      'artifact metadata failed integrity verification',
      500,
    );
  }
}

function abortBody(body: unknown, reason: Error): void {
  if (typeof body !== 'object' || body === null) return;
  const destroy = (body as { destroy?: unknown }).destroy;
  if (typeof destroy === 'function') {
    try {
      destroy.call(body, reason);
    } catch {
      // The bounded read is already failing closed.
    }
  }
  const cancel = (body as { cancel?: unknown }).cancel;
  if (typeof cancel === 'function') {
    try {
      void cancel.call(body, reason);
    } catch {
      // The bounded read is already failing closed.
    }
  }
}

async function bodyBytes(
  body: unknown,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const add = (value: Uint8Array) => {
    total += value.byteLength;
    if (total > maxBytes) {
      const error = new ArtifactStoreAdapterError(
        'artifact_too_large',
        'artifact exceeds read limit',
        413,
      );
      abortBody(body, error);
      throw error;
    }
    chunks.push(Uint8Array.from(value));
  };
  const consume = async () => {
    if (body instanceof Uint8Array) add(body);
    else if (
      typeof body === 'object' &&
      body !== null &&
      Symbol.asyncIterator in body
    ) {
      for await (const chunk of body as AsyncIterable<unknown>) {
        if (typeof chunk === 'string') add(new TextEncoder().encode(chunk));
        else if (chunk instanceof Uint8Array) add(chunk);
        else
          throw new ArtifactStoreAdapterError(
            'artifact_integrity_error',
            'artifact body is invalid',
            500,
          );
      }
    } else {
      throw new ArtifactStoreAdapterError(
        'artifact_integrity_error',
        'artifact body is invalid',
        500,
      );
    }
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      consume(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new ArtifactStoreAdapterError(
            'artifact_store_unavailable',
            'artifact storage read timed out',
            504,
          );
          abortBody(body, error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function objectMetadata(value: ArtifactMetadata): Record<string, string> {
  return {
    digest: value.digest,
    'created-at': value.createdAt,
    'expires-at': value.expiresAt,
    'retention-class': value.retentionClass,
  };
}

export function createR2ArtifactStorageWithDependencies(
  options: R2ArtifactStorageDependencies,
): { readonly store: ArtifactStore; readonly admin: ArtifactAdminStore } {
  if (!SAFE_BUCKET.test(options.bucket))
    throw new Error('R2 bucket is invalid');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = options.retry?.attempts ?? 2;
  const baseDelayMs = options.retry?.baseDelayMs ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000)
    throw new Error('R2 timeout is invalid');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3)
    throw new Error('R2 retry attempts are invalid');
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());
  const cursors = options.cursorCodec ?? createArtifactCursorCodec();

  const send = async (command: R2Command): Promise<Record<string, unknown>> => {
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await options.client.send(command, {
          abortSignal: controller.signal,
        });
      } catch (error) {
        last = error;
        if (!transient(error) || attempt === attempts) throw error;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw last;
  };

  const readVerified = async (
    key: string,
    maxBytes: number,
  ): Promise<import('@agentos/core').ArtifactValue | undefined> => {
    try {
      const response = await send({
        kind: 'GetObject',
        input: { Bucket: options.bucket, Key: key },
      });
      const metadata = metadataFromResponse(key, response);
      if (metadata.sizeBytes > maxBytes)
        throw new ArtifactStoreAdapterError(
          'artifact_too_large',
          'artifact exceeds read limit',
          413,
        );
      const bytes = await bodyBytes(response.Body, maxBytes, timeoutMs);
      if (
        bytes.byteLength !== metadata.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== metadata.digest
      )
        throw new ArtifactStoreAdapterError(
          'artifact_integrity_error',
          'artifact failed integrity verification',
          500,
        );
      return Object.freeze({ ...metadata, bytes });
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  };

  const unavailable = (error: unknown): never => {
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
  };

  const reconcile = (
    existing: ArtifactMetadata,
    wanted: ArtifactMetadata,
  ): ArtifactMetadata => {
    if (
      existing.digest !== wanted.digest ||
      existing.key !== wanted.key ||
      existing.projectId !== wanted.projectId ||
      existing.runId !== wanted.runId ||
      existing.stepId !== wanted.stepId ||
      existing.artifactId !== wanted.artifactId ||
      existing.version !== wanted.version ||
      existing.mediaType !== wanted.mediaType ||
      existing.retentionClass !== wanted.retentionClass ||
      existing.sizeBytes !== wanted.sizeBytes ||
      existing.createdAt !== wanted.createdAt ||
      existing.expiresAt !== wanted.expiresAt
    )
      throw new ArtifactStoreAdapterError(
        'artifact_conflict',
        'artifact key already exists with different metadata',
        409,
      );
    return Object.freeze({
      key: existing.key,
      projectId: existing.projectId,
      runId: existing.runId,
      stepId: existing.stepId,
      artifactId: existing.artifactId,
      version: existing.version,
      digest: existing.digest,
      mediaType: existing.mediaType,
      sizeBytes: existing.sizeBytes,
      retentionClass: existing.retentionClass,
      createdAt: existing.createdAt,
      expiresAt: existing.expiresAt,
    });
  };

  const store: ArtifactStore = Object.freeze({
    async put(request: ArtifactPutRequest) {
      try {
        const prepared = prepareArtifactPut(request, now(), {
          ...(options.maxBytes === undefined
            ? {}
            : { maxBytes: options.maxBytes }),
        });
        const leaseId = randomUUID();
        const leaseNow = now();
        const claimed = await options.manifest.beginWrite(prepared, {
          leaseId,
          now: leaseNow.toISOString(),
          expiresAt: new Date(leaseNow.getTime() + 120_000).toISOString(),
        });
        try {
          if (claimed.key !== prepared.key)
            throw new ArtifactStoreAdapterError(
              'artifact_conflict',
              'artifact version already exists with different content',
              409,
            );
          const existing = await readVerified(prepared.key, prepared.sizeBytes);
          if (existing !== undefined) return reconcile(existing, claimed);
          try {
            await send({
              kind: 'PutObject',
              input: {
                Bucket: options.bucket,
                Key: prepared.key,
                Body: prepared.bytes,
                ContentLength: prepared.sizeBytes,
                ContentType: prepared.mediaType,
                IfNoneMatch: '*',
                Metadata: objectMetadata(claimed),
              },
            });
            return claimed;
          } catch (error) {
            if (!precondition(error)) throw error;
            const raced = await readVerified(prepared.key, prepared.sizeBytes);
            if (raced === undefined) throw error;
            return reconcile(raced, claimed);
          }
        } finally {
          await options.manifest.finishWrite(claimed, leaseId);
        }
      } catch (error) {
        return unavailable(error);
      }
    },
    async get(request: ArtifactGetRequest) {
      try {
        if (!artifactKeyMatchesScope(request.key, request.scope))
          throw new ArtifactStoreAdapterError(
            'artifact_scope_denied',
            'artifact is outside the requested scope',
            403,
          );
        const claimed = await options.manifest.get(request.scope, request.key);
        if (claimed === undefined) return undefined;
        const limit =
          request.maxBytes ?? options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
        const value = await readVerified(request.key, limit);
        if (value === undefined)
          throw new ArtifactStoreAdapterError(
            'artifact_integrity_error',
            'artifact manifest references a missing object',
            500,
          );
        reconcile(value, claimed);
        return value;
      } catch (error) {
        return unavailable(error);
      }
    },
    async list(input: ArtifactListRequest) {
      try {
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
        const page = await options.manifest.list({
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
      } catch (error) {
        return unavailable(error);
      }
    },
  });

  const admin: ArtifactAdminStore = Object.freeze({
    async delete(key: string, audit?: Omit<ArtifactDeletionAudit, 'key'>) {
      try {
        const parts = parseArtifactKey(key);
        const reservationTime = now().toISOString();
        const deletionAudit = {
          key,
          deletedAt: audit?.deletedAt ?? reservationTime,
          reason: audit?.reason ?? 'control_plane_delete',
        };
        const expected = await options.manifest.reserveDeletion(
          parts,
          key,
          deletionAudit,
          reservationTime,
        );
        if (expected === undefined) return false;
        await send({
          kind: 'DeleteObject',
          input: { Bucket: options.bucket, Key: key },
        });
        await options.manifest.finalizeDeletion(expected, deletionAudit);
        return true;
      } catch (error) {
        return unavailable(error);
      }
    },
  });
  return Object.freeze({ store, admin });
}
