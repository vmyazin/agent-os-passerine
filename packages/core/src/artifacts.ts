import { createHash } from 'node:crypto';

export const DEFAULT_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_ARTIFACT_LIST_LIMIT = 100;
export const MAX_ARTIFACT_LIST_LIMIT = 1_000;

const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/x-ndjson',
  'application/xml',
  'application/junit+xml',
  'application/vnd.agentos.patch+json',
]);
const BINARY_MEDIA_TYPES = new Set([
  'application/octet-stream',
  'application/zip',
  'application/gzip',
  'application/x-tar',
]);
const RETENTION_MILLISECONDS = {
  'source-bundle': 24 * 60 * 60 * 1_000,
  'cloud-session-upload': 24 * 60 * 60 * 1_000,
  working: 30 * 24 * 60 * 60 * 1_000,
} as const;

export type ArtifactRetentionClass = keyof typeof RETENTION_MILLISECONDS;

export interface ArtifactScope {
  readonly projectId: string;
  readonly runId: string;
  readonly stepId: string;
}

export interface ArtifactKeyParts extends ArtifactScope {
  readonly artifactId: string;
  readonly version: number;
  readonly digest: string;
}

export interface ArtifactPutRequest {
  readonly scope: ArtifactScope;
  readonly artifactId: string;
  readonly version: number;
  readonly digest?: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly retentionClass?: ArtifactRetentionClass;
  readonly expiresAt?: string;
}

export interface ArtifactMetadata extends ArtifactKeyParts {
  readonly key: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly retentionClass: ArtifactRetentionClass;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ArtifactValue extends ArtifactMetadata {
  readonly bytes: Uint8Array;
}

export interface ArtifactGetRequest {
  readonly scope: ArtifactScope;
  readonly key: string;
  readonly maxBytes?: number;
}

export interface ArtifactListRequest {
  readonly scope: ArtifactScope;
  readonly artifactPrefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ArtifactListPage {
  readonly items: readonly ArtifactMetadata[];
  readonly nextCursor?: string;
}

export interface ArtifactStore {
  get(request: ArtifactGetRequest): Promise<ArtifactValue | undefined>;
  put(request: ArtifactPutRequest): Promise<ArtifactMetadata>;
  list(request: ArtifactListRequest): Promise<ArtifactListPage>;
}

export interface ArtifactAdminStore {
  delete(
    key: string,
    audit?: Omit<ArtifactDeletionAudit, 'key'>,
  ): Promise<boolean>;
}

export interface ArtifactManifestListRequest {
  readonly scope: ArtifactScope;
  readonly artifactPrefix?: string;
  readonly after?: string;
  readonly limit: number;
}

export interface ArtifactManifestListPage {
  readonly items: readonly ArtifactMetadata[];
  /** The last scanned key. It may be present when items is empty. */
  readonly nextAfter?: string;
}

export interface ArtifactDeletionAudit {
  readonly key: string;
  readonly deletedAt: string;
  readonly reason: 'retention_expired' | 'control_plane_delete';
}

/**
 * Authoritative logical-version ledger. Implementations must atomically bind a
 * (project, run, step, artifact, version) tuple to one immutable metadata row.
 */
export interface ArtifactManifestStore {
  claim(metadata: ArtifactMetadata): Promise<ArtifactMetadata>;
  get(scope: ArtifactScope, key: string): Promise<ArtifactMetadata | undefined>;
  list(request: ArtifactManifestListRequest): Promise<ArtifactManifestListPage>;
  listExpired(
    before: string,
    limit: number,
  ): Promise<readonly ArtifactMetadata[]>;
  markDeleted(audit: ArtifactDeletionAudit): Promise<void>;
}

export interface ArtifactPreparationOptions {
  readonly maxBytes?: number;
}

export class ArtifactValidationError extends Error {
  readonly code = 'invalid_artifact';

  constructor(message: string) {
    super(message);
    this.name = 'ArtifactValidationError';
  }
}

function segment(value: string, label: string): string {
  if (!SEGMENT.test(value) || value.includes('..') || value.startsWith('.'))
    throw new ArtifactValidationError(`${label} is not a canonical segment`);
  return value;
}

function positiveVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new ArtifactValidationError('version must be a positive integer');
  return value;
}

function sha256(value: string, label = 'digest'): string {
  if (!DIGEST.test(value))
    throw new ArtifactValidationError(`${label} must be a SHA-256 digest`);
  return value;
}

export function normalizeArtifactScope(scope: ArtifactScope): ArtifactScope {
  return Object.freeze({
    projectId: segment(scope.projectId, 'projectId'),
    runId: segment(scope.runId, 'runId'),
    stepId: segment(scope.stepId, 'stepId'),
  });
}

export function artifactScopePrefix(scope: ArtifactScope): string {
  const value = normalizeArtifactScope(scope);
  return `artifacts/v1/${value.projectId}/${value.runId}/${value.stepId}/`;
}

export function artifactLogicalKey(
  parts: Pick<ArtifactKeyParts, 'stepId' | 'artifactId' | 'version'>,
): string {
  return `artifact-manifest/v1/${segment(parts.stepId, 'stepId')}/${segment(
    parts.artifactId,
    'artifactId',
  )}/${positiveVersion(parts.version)}`;
}

export function buildArtifactKey(parts: ArtifactKeyParts): string {
  const scope = artifactScopePrefix(parts);
  const artifactId = segment(parts.artifactId, 'artifactId');
  const version = positiveVersion(parts.version);
  const digest = sha256(parts.digest);
  return `${scope}${artifactId}/${version}/sha256/${digest}`;
}

export function parseArtifactKey(key: string): ArtifactKeyParts {
  if (key.length > 1_024 || key.normalize('NFC') !== key)
    throw new ArtifactValidationError('artifact key is not canonical');
  const parts = key.split('/');
  if (
    parts.length !== 9 ||
    parts[0] !== 'artifacts' ||
    parts[1] !== 'v1' ||
    parts[7] !== 'sha256'
  )
    throw new ArtifactValidationError('artifact key has an invalid shape');
  const version = Number(parts[6]);
  const parsed = {
    projectId: segment(parts[2] ?? '', 'projectId'),
    runId: segment(parts[3] ?? '', 'runId'),
    stepId: segment(parts[4] ?? '', 'stepId'),
    artifactId: segment(parts[5] ?? '', 'artifactId'),
    version: positiveVersion(version),
    digest: sha256(parts[8] ?? ''),
  };
  if (String(version) !== parts[6] || buildArtifactKey(parsed) !== key)
    throw new ArtifactValidationError('artifact key is not canonical');
  return Object.freeze(parsed);
}

export function artifactKeyMatchesScope(
  key: string,
  scope: ArtifactScope,
): boolean {
  const parsed = parseArtifactKey(key);
  const expected = normalizeArtifactScope(scope);
  return (
    parsed.projectId === expected.projectId &&
    parsed.runId === expected.runId &&
    parsed.stepId === expected.stepId
  );
}

export function normalizeArtifactMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  const base = normalized.split(';', 1)[0] ?? '';
  const validParameters =
    normalized === base || normalized === `${base}; charset=utf-8`;
  if (
    !validParameters ||
    (!base.startsWith('text/') &&
      !TEXT_MEDIA_TYPES.has(base) &&
      !BINARY_MEDIA_TYPES.has(base))
  )
    throw new ArtifactValidationError('artifact media type is not allowed');
  if (base === 'text/html' || base === 'text/javascript')
    throw new ArtifactValidationError('artifact media type is not allowed');
  return normalized;
}

function isTextMediaType(mediaType: string): boolean {
  const base = mediaType.split(';', 1)[0] ?? mediaType;
  return base.startsWith('text/') || TEXT_MEDIA_TYPES.has(base);
}

function validateText(bytes: Uint8Array): void {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0'))
      throw new ArtifactValidationError('text artifact contains a NUL byte');
  } catch (error) {
    if (error instanceof ArtifactValidationError) throw error;
    throw new ArtifactValidationError('text artifact must contain valid UTF-8');
  }
}

function timestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new ArtifactValidationError(`${label} must be a timestamp`);
  const normalized = new Date(milliseconds).toISOString();
  if (normalized !== value)
    throw new ArtifactValidationError(`${label} must be canonical ISO-8601`);
  return normalized;
}

export function prepareArtifactPut(
  request: ArtifactPutRequest,
  now = new Date(),
  options: ArtifactPreparationOptions = {},
): ArtifactValue {
  const maxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new ArtifactValidationError('maxBytes must be a positive integer');
  if (!(request.bytes instanceof Uint8Array))
    throw new ArtifactValidationError('artifact bytes must be a Uint8Array');
  if (request.bytes.byteLength > maxBytes)
    throw new ArtifactValidationError('artifact is too large');
  const mediaType = normalizeArtifactMediaType(request.mediaType);
  if (isTextMediaType(mediaType)) validateText(request.bytes);
  const digest = createHash('sha256').update(request.bytes).digest('hex');
  if (request.digest !== undefined && request.digest !== digest)
    throw new ArtifactValidationError('artifact digest does not match bytes');
  const retentionClass = request.retentionClass ?? 'working';
  const retentionMs = RETENTION_MILLISECONDS[retentionClass];
  if (retentionMs === undefined)
    throw new ArtifactValidationError('artifact retention class is invalid');
  const createdAt = new Date(now.getTime()).toISOString();
  const expiresAt = request.expiresAt
    ? timestamp(request.expiresAt, 'expiresAt')
    : new Date(now.getTime() + retentionMs).toISOString();
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= now.getTime() || expiresMs > now.getTime() + retentionMs)
    throw new ArtifactValidationError(
      `artifact retention exceeds ${retentionClass} maximum`,
    );
  const parts = {
    ...normalizeArtifactScope(request.scope),
    artifactId: segment(request.artifactId, 'artifactId'),
    version: positiveVersion(request.version),
    digest,
  };
  return Object.freeze({
    ...parts,
    key: buildArtifactKey(parts),
    bytes: Uint8Array.from(request.bytes),
    mediaType,
    sizeBytes: request.bytes.byteLength,
    retentionClass,
    createdAt,
    expiresAt,
  });
}

export function validateArtifactMetadata(
  metadata: ArtifactMetadata,
): ArtifactMetadata {
  const parts = parseArtifactKey(metadata.key);
  if (
    parts.projectId !== metadata.projectId ||
    parts.runId !== metadata.runId ||
    parts.stepId !== metadata.stepId ||
    parts.artifactId !== metadata.artifactId ||
    parts.version !== metadata.version ||
    parts.digest !== metadata.digest
  )
    throw new ArtifactValidationError('artifact metadata does not match key');
  if (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0)
    throw new ArtifactValidationError('artifact size is invalid');
  const retentionMs = RETENTION_MILLISECONDS[metadata.retentionClass];
  if (retentionMs === undefined)
    throw new ArtifactValidationError('artifact retention class is invalid');
  normalizeArtifactMediaType(metadata.mediaType);
  const createdAt = Date.parse(timestamp(metadata.createdAt, 'createdAt'));
  const expiresAt = Date.parse(timestamp(metadata.expiresAt, 'expiresAt'));
  if (expiresAt <= createdAt || expiresAt > createdAt + retentionMs)
    throw new ArtifactValidationError('artifact retention window is invalid');
  return metadata;
}

export function normalizeArtifactListRequest(
  request: ArtifactListRequest,
): ArtifactListRequest {
  const limit = request.limit ?? DEFAULT_ARTIFACT_LIST_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_ARTIFACT_LIST_LIMIT
  )
    throw new ArtifactValidationError('artifact list limit is invalid');
  const cursor = request.cursor;
  if (
    cursor !== undefined &&
    (cursor.length < 1 ||
      cursor.length > 2_048 ||
      !/^[A-Za-z0-9_.-]+$/.test(cursor))
  )
    throw new ArtifactValidationError('artifact list cursor is invalid');
  return Object.freeze({
    scope: normalizeArtifactScope(request.scope),
    ...(request.artifactPrefix === undefined
      ? {}
      : { artifactPrefix: segment(request.artifactPrefix, 'artifactPrefix') }),
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  });
}
