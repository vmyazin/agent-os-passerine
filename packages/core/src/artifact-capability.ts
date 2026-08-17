import { createHmac, timingSafeEqual } from 'node:crypto';

import { DEFAULT_ARTIFACT_MAX_BYTES } from './artifacts.js';

export const ARTIFACT_CAPABILITY_MAX_LIFETIME_MS = 60 * 60 * 1_000;
export const ARTIFACT_CAPABILITY_MAX_FUTURE_MS = 5 * 60 * 1_000;

export type ArtifactCapabilityMethod =
  'artifact.get' | 'artifact.put' | 'artifact.list';

export interface ArtifactCapabilityClaims {
  readonly audience: string;
  readonly methods: readonly ArtifactCapabilityMethod[];
  readonly projectId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly prefix?: string;
  readonly maxBytes: number;
  readonly expiresAt: string;
  readonly notBefore: string;
  readonly nonce: string;
}

export interface ArtifactCapabilityKey {
  readonly keyId: string;
  readonly secret: string | Uint8Array;
}

export interface ArtifactCapabilityVerification {
  readonly audience: string;
  readonly method?: string;
  readonly now?: Date;
  readonly projectId?: string;
  readonly runId?: string;
  readonly stepId?: string;
  readonly artifactId?: string;
  readonly bytes?: number;
}

export interface ArtifactCapabilityIssuer {
  issue(claims: ArtifactCapabilityClaims, now?: Date): string;
}

export interface ArtifactCapabilityVerifier {
  verify(
    token: string,
    expected: ArtifactCapabilityVerification,
  ): ArtifactCapabilityClaims;
}

export class ArtifactCapabilityError extends Error {
  readonly code = 'artifact_capability_denied';

  constructor(message = 'artifact capability denied') {
    super(message);
    this.name = 'ArtifactCapabilityError';
  }
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const METHODS = new Set<ArtifactCapabilityMethod>([
  'artifact.get',
  'artifact.put',
  'artifact.list',
]);

function keySecret(value: ArtifactCapabilityKey['secret']): Uint8Array {
  const bytes =
    typeof value === 'string'
      ? Buffer.from(value, 'utf8')
      : Uint8Array.from(value);
  if (bytes.byteLength < 32)
    throw new Error(
      'Artifact capability secret must contain at least 32 bytes',
    );
  return bytes;
}

function configuredKey(key: ArtifactCapabilityKey): {
  readonly keyId: string;
  readonly secret: Uint8Array;
} {
  if (!SAFE.test(key.keyId))
    throw new Error('Artifact capability keyId is invalid');
  return { keyId: key.keyId, secret: keySecret(key.secret) };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object' || value === null)
    throw new Error('Artifact capability claims must be JSON values');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Artifact capability claims must be plain objects');
  return `{${Object.entries(value)
    .sort(([left], [right]) => compare(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ArtifactCapabilityError();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value)
    throw new ArtifactCapabilityError();
  return bytes;
}

function signature(secret: Uint8Array, signed: string): Uint8Array {
  return createHmac('sha256', secret)
    .update('agentos-artifact-capability:v1\0', 'utf8')
    .update(signed, 'utf8')
    .digest();
}

function iso(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  )
    throw new Error(`${label} must be canonical ISO-8601`);
  return milliseconds;
}

function safeClaim(value: string, label: string): string {
  if (!SAFE.test(value) || value.includes('..') || value.startsWith('.'))
    throw new Error(`${label} is invalid`);
  return value;
}

function normalizeClaims(
  claims: ArtifactCapabilityClaims,
  now: Date,
): ArtifactCapabilityClaims {
  safeClaim(claims.audience, 'audience');
  safeClaim(claims.projectId, 'projectId');
  safeClaim(claims.runId, 'runId');
  safeClaim(claims.stepId, 'stepId');
  if (claims.prefix !== undefined) safeClaim(claims.prefix, 'prefix');
  if (!NONCE.test(claims.nonce)) throw new Error('nonce is invalid');
  if (
    !Number.isSafeInteger(claims.maxBytes) ||
    claims.maxBytes < 1 ||
    claims.maxBytes > DEFAULT_ARTIFACT_MAX_BYTES
  )
    throw new Error('maxBytes is invalid');
  if (claims.methods.length < 1) throw new Error('methods must not be empty');
  const methods = [...new Set(claims.methods)];
  if (
    methods.length !== claims.methods.length ||
    methods.some((method) => !METHODS.has(method))
  )
    throw new Error('Artifact capability method is invalid');
  const expires = iso(claims.expiresAt, 'expiresAt');
  const notBefore = iso(claims.notBefore, 'notBefore');
  if (notBefore > now.getTime() + ARTIFACT_CAPABILITY_MAX_FUTURE_MS)
    throw new Error('Artifact capability notBefore is too far in the future');
  if (
    expires <= notBefore ||
    expires - Math.min(notBefore, now.getTime()) >
      ARTIFACT_CAPABILITY_MAX_LIFETIME_MS
  )
    throw new Error('Artifact capability lifetime is invalid');
  return Object.freeze({
    audience: claims.audience,
    methods: Object.freeze(methods),
    projectId: claims.projectId,
    runId: claims.runId,
    stepId: claims.stepId,
    ...(claims.prefix === undefined ? {} : { prefix: claims.prefix }),
    maxBytes: claims.maxBytes,
    expiresAt: claims.expiresAt,
    notBefore: claims.notBefore,
    nonce: claims.nonce,
  });
}

interface Payload {
  readonly version: 1;
  readonly issuedAt: string;
  readonly claims: ArtifactCapabilityClaims;
}

export function createArtifactCapabilityIssuer(
  keyInput: ArtifactCapabilityKey,
): ArtifactCapabilityIssuer {
  const key = configuredKey(keyInput);
  return Object.freeze({
    issue(claims: ArtifactCapabilityClaims, now = new Date()): string {
      const normalized = normalizeClaims(claims, now);
      const payload: Payload = {
        version: 1,
        issuedAt: now.toISOString(),
        claims: normalized,
      };
      const encoded = base64url(canonical(payload));
      const signed = `aoc1.${key.keyId}.${encoded}`;
      return `${signed}.${base64url(signature(key.secret, signed))}`;
    },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(encoded: string, now: Date): Payload {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        decodeBase64url(encoded),
      ),
    );
  } catch {
    throw new ArtifactCapabilityError();
  }
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.issuedAt !== 'string' ||
    !record(value.claims)
  )
    throw new ArtifactCapabilityError();
  let issued: number;
  try {
    issued = iso(value.issuedAt, 'issuedAt');
  } catch {
    throw new ArtifactCapabilityError();
  }
  if (issued > now.getTime() + ARTIFACT_CAPABILITY_MAX_FUTURE_MS)
    throw new ArtifactCapabilityError('artifact capability is from the future');
  try {
    return {
      version: 1,
      issuedAt: value.issuedAt,
      claims: normalizeClaims(
        value.claims as unknown as ArtifactCapabilityClaims,
        new Date(issued),
      ),
    };
  } catch {
    throw new ArtifactCapabilityError();
  }
}

export function createArtifactCapabilityVerifier(options: {
  readonly keys: readonly ArtifactCapabilityKey[];
}): ArtifactCapabilityVerifier {
  if (options.keys.length < 1)
    throw new Error('At least one artifact capability key is required');
  const keys = new Map<string, Uint8Array>();
  for (const input of options.keys) {
    const key = configuredKey(input);
    if (keys.has(key.keyId))
      throw new Error(`Duplicate artifact capability keyId: ${key.keyId}`);
    keys.set(key.keyId, key.secret);
  }
  return Object.freeze({
    verify(
      token: string,
      expected: ArtifactCapabilityVerification,
    ): ArtifactCapabilityClaims {
      if (typeof token !== 'string' || token.length > 8_192)
        throw new ArtifactCapabilityError();
      const parts = token.split('.');
      if (parts.length !== 4 || parts[0] !== 'aoc1')
        throw new ArtifactCapabilityError();
      const key = keys.get(parts[1] ?? '');
      if (key === undefined) throw new ArtifactCapabilityError();
      const signed = parts.slice(0, 3).join('.');
      let supplied: Uint8Array;
      try {
        supplied = decodeBase64url(parts[3] ?? '');
      } catch {
        throw new ArtifactCapabilityError();
      }
      const wanted = signature(key, signed);
      if (
        supplied.byteLength !== wanted.byteLength ||
        !timingSafeEqual(supplied, wanted)
      )
        throw new ArtifactCapabilityError();
      const now = expected.now ?? new Date();
      const payload = parsePayload(parts[2] ?? '', now);
      const claims = payload.claims;
      const nowMs = now.getTime();
      if (nowMs < Date.parse(claims.notBefore))
        throw new ArtifactCapabilityError('artifact capability is not active');
      if (nowMs >= Date.parse(claims.expiresAt))
        throw new ArtifactCapabilityError('artifact capability is expired');
      if (
        claims.audience !== expected.audience ||
        (expected.method !== undefined &&
          !claims.methods.includes(
            expected.method as ArtifactCapabilityMethod,
          )) ||
        (expected.projectId !== undefined &&
          claims.projectId !== expected.projectId) ||
        (expected.runId !== undefined && claims.runId !== expected.runId) ||
        (expected.stepId !== undefined && claims.stepId !== expected.stepId) ||
        (expected.artifactId !== undefined &&
          claims.prefix !== undefined &&
          !expected.artifactId.startsWith(claims.prefix)) ||
        (expected.bytes !== undefined &&
          (!Number.isSafeInteger(expected.bytes) ||
            expected.bytes < 0 ||
            expected.bytes > claims.maxBytes))
      )
        throw new ArtifactCapabilityError();
      return claims;
    },
  });
}
