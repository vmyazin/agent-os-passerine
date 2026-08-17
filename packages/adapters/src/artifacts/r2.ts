import { createHash } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type DeleteObjectCommandInput,
  type GetObjectCommandInput,
  type HeadObjectCommandInput,
  type ListObjectsV2CommandInput,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import {
  DEFAULT_ARTIFACT_MAX_BYTES,
  ArtifactValidationError,
  artifactKeyMatchesScope,
  artifactScopePrefix,
  normalizeArtifactListRequest,
  parseArtifactKey,
  prepareArtifactPut,
  validateArtifactMetadata,
  type ArtifactAdminStore,
  type ArtifactGetRequest,
  type ArtifactListRequest,
  type ArtifactMetadata,
  type ArtifactPutRequest,
  type ArtifactStore,
} from '@agentos/core';

import { decodeArtifactCursor, encodeArtifactCursor } from './cursor.js';
import { ArtifactStoreAdapterError } from './errors.js';

export type R2CommandKind =
  'HeadObject' | 'PutObject' | 'GetObject' | 'ListObjectsV2' | 'DeleteObject';

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
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly retryAttempts?: number;
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

export interface R2ArtifactStorageDependencies {
  readonly client: R2SdkClient;
  readonly bucket: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly retry?: { readonly attempts: number; readonly baseDelayMs: number };
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const SAFE_ACCOUNT = /^[A-Za-z0-9_-]{3,128}$/;
const SAFE_BUCKET = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/;
const DEFAULT_TIMEOUT_MS = 15_000;

function nonEmpty(value: string, label: string): string {
  if (value.trim() === '') throw new Error(`R2 ${label} is required`);
  return value;
}

function endpoint(options: R2ArtifactStorageOptions): string {
  if (!SAFE_ACCOUNT.test(options.accountId))
    throw new Error('R2 accountId is invalid');
  const value =
    options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('R2 endpoint is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== ''
  )
    throw new Error('R2 endpoint must use HTTPS without embedded credentials');
  return parsed.toString().replace(/\/$/, '');
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
    if (command.kind === 'HeadObject')
      return (await this.client.send(
        new HeadObjectCommand(
          command.input as unknown as HeadObjectCommandInput,
        ),
        handlerOptions,
      )) as unknown as Record<string, unknown>;
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
    if (command.kind === 'ListObjectsV2')
      return (await this.client.send(
        new ListObjectsV2Command(
          command.input as unknown as ListObjectsV2CommandInput,
        ),
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

async function bodyBytes(body: unknown, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const add = (value: Uint8Array) => {
    total += value.byteLength;
    if (total > maxBytes)
      throw new ArtifactStoreAdapterError(
        'artifact_too_large',
        'artifact exceeds read limit',
        413,
      );
    chunks.push(Uint8Array.from(value));
  };
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

  const head = async (key: string): Promise<ArtifactMetadata | undefined> => {
    try {
      return metadataFromResponse(
        key,
        await send({
          kind: 'HeadObject',
          input: { Bucket: options.bucket, Key: key },
        }),
      );
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
      existing.mediaType !== wanted.mediaType ||
      existing.retentionClass !== wanted.retentionClass ||
      existing.sizeBytes !== wanted.sizeBytes
    )
      throw new ArtifactStoreAdapterError(
        'artifact_conflict',
        'artifact key already exists with different metadata',
        409,
      );
    return existing;
  };

  const store: ArtifactStore = Object.freeze({
    async put(request: ArtifactPutRequest) {
      try {
        const prepared = prepareArtifactPut(request, now(), {
          ...(options.maxBytes === undefined
            ? {}
            : { maxBytes: options.maxBytes }),
        });
        const existing = await head(prepared.key);
        if (existing !== undefined) return reconcile(existing, prepared);
        try {
          await send({
            kind: 'PutObject',
            input: {
              Bucket: options.bucket,
              Key: prepared.key,
              Body: prepared.bytes,
              ContentLength: prepared.sizeBytes,
              ContentType: prepared.mediaType,
              ChecksumSHA256: Buffer.from(prepared.digest, 'hex').toString(
                'base64',
              ),
              IfNoneMatch: '*',
              Metadata: objectMetadata(prepared),
            },
          });
          return metadataFromResponse(prepared.key, {
            ContentLength: prepared.sizeBytes,
            ContentType: prepared.mediaType,
            Metadata: objectMetadata(prepared),
          });
        } catch (error) {
          if (!precondition(error)) throw error;
          const raced = await head(prepared.key);
          if (raced === undefined) throw error;
          return reconcile(raced, prepared);
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
        let response: Record<string, unknown>;
        try {
          response = await send({
            kind: 'GetObject',
            input: { Bucket: options.bucket, Key: request.key },
          });
        } catch (error) {
          if (missing(error)) return undefined;
          throw error;
        }
        const metadata = metadataFromResponse(request.key, response);
        const limit =
          request.maxBytes ?? options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
        if (metadata.sizeBytes > limit)
          throw new ArtifactStoreAdapterError(
            'artifact_too_large',
            'artifact exceeds read limit',
            413,
          );
        const bytes = await bodyBytes(response.Body, limit);
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
        return unavailable(error);
      }
    },
    async list(input: ArtifactListRequest) {
      try {
        const request = normalizeArtifactListRequest(input);
        const after = decodeArtifactCursor(request.scope, request.cursor);
        const scopePrefix = artifactScopePrefix(request.scope);
        const prefix = `${scopePrefix}${request.artifactPrefix ?? ''}`;
        const limit = request.limit!;
        const response = await send({
          kind: 'ListObjectsV2',
          input: {
            Bucket: options.bucket,
            Prefix: prefix,
            ...(after === undefined ? {} : { StartAfter: after }),
            MaxKeys: limit,
          },
        });
        const contents = Array.isArray(response.Contents)
          ? response.Contents
          : [];
        const keys = contents
          .map((item) =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { Key?: unknown }).Key === 'string'
              ? (item as { Key: string }).Key
              : undefined,
          )
          .filter((key): key is string => key !== undefined)
          .filter((key) => artifactKeyMatchesScope(key, request.scope))
          .slice(0, limit);
        const values: ArtifactMetadata[] = [];
        for (const key of keys.slice(0, limit)) {
          const value = await head(key);
          if (value === undefined) continue;
          if (
            request.artifactPrefix === undefined ||
            value.artifactId.startsWith(request.artifactPrefix)
          )
            values.push(value);
        }
        return Object.freeze({
          items: Object.freeze(values),
          ...(response.IsTruncated !== true || values.length === 0
            ? {}
            : {
                nextCursor: encodeArtifactCursor(
                  request.scope,
                  values.at(-1)!.key,
                ),
              }),
        });
      } catch (error) {
        return unavailable(error);
      }
    },
  });

  const admin: ArtifactAdminStore = Object.freeze({
    async delete(key: string) {
      try {
        parseArtifactKey(key);
        const existing = await head(key);
        if (existing === undefined) return false;
        await send({
          kind: 'DeleteObject',
          input: { Bucket: options.bucket, Key: key },
        });
        return true;
      } catch (error) {
        return unavailable(error);
      }
    },
  });
  return Object.freeze({ store, admin });
}
