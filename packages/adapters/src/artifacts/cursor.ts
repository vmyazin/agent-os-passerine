import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ArtifactValidationError,
  artifactKeyMatchesScope,
  artifactScopePrefix,
  parseArtifactKey,
  type ArtifactScope,
} from '@agentos/core';

export interface ArtifactCursorKey {
  readonly keyId: string;
  readonly secret: string | Uint8Array;
}

export interface ArtifactCursorQuery {
  readonly scope: ArtifactScope;
  readonly artifactPrefix?: string;
  readonly limit: number;
}

export interface ArtifactCursorCodec {
  encode(query: ArtifactCursorQuery, after: string): string;
  decode(
    query: ArtifactCursorQuery,
    cursor: string | undefined,
  ): string | undefined;
}

interface CursorPayload {
  readonly v: 1;
  readonly queryVersion: 'artifact-list-v1';
  readonly scope: string;
  readonly prefix: string;
  readonly limit: number;
  readonly after: string;
}

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function secretBytes(value: ArtifactCursorKey['secret']): Uint8Array {
  const bytes =
    typeof value === 'string'
      ? Buffer.from(value, 'utf8')
      : Uint8Array.from(value);
  if (bytes.byteLength < 32)
    throw new Error('Artifact cursor secret must contain at least 32 bytes');
  return bytes;
}

function signature(secret: Uint8Array, signed: string): Uint8Array {
  return createHmac('sha256', secret)
    .update('agentos-artifact-cursor:v1\0', 'utf8')
    .update(signed, 'utf8')
    .digest();
}

function payload(query: ArtifactCursorQuery, after: string): CursorPayload {
  parseArtifactKey(after);
  if (!artifactKeyMatchesScope(after, query.scope))
    throw new ArtifactValidationError(
      'artifact cursor is outside the requested scope',
    );
  return {
    v: 1,
    queryVersion: 'artifact-list-v1',
    scope: artifactScopePrefix(query.scope),
    prefix: query.artifactPrefix ?? '',
    limit: query.limit,
    after,
  };
}

function decodePart(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new ArtifactValidationError('artifact list cursor is invalid');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value)
    throw new ArtifactValidationError('artifact list cursor is invalid');
  return bytes;
}

export function createArtifactCursorCodec(options?: {
  readonly keys?: readonly ArtifactCursorKey[];
}): ArtifactCursorCodec {
  const configured = options?.keys ?? [
    { keyId: 'memory', secret: randomBytes(32) },
  ];
  if (configured.length < 1)
    throw new Error('At least one artifact cursor key is required');
  const keys = new Map<string, Uint8Array>();
  for (const key of configured) {
    if (!KEY_ID.test(key.keyId))
      throw new Error('Artifact cursor keyId is invalid');
    if (keys.has(key.keyId)) throw new Error('Duplicate artifact cursor keyId');
    keys.set(key.keyId, secretBytes(key.secret));
  }
  const signing = configured[0]!;
  const signingSecret = keys.get(signing.keyId)!;
  return Object.freeze({
    encode(query: ArtifactCursorQuery, after: string): string {
      const encoded = Buffer.from(
        JSON.stringify(payload(query, after)),
        'utf8',
      ).toString('base64url');
      const signed = `aocur1.${signing.keyId}.${encoded}`;
      return `${signed}.${Buffer.from(
        signature(signingSecret, signed),
      ).toString('base64url')}`;
    },
    decode(
      query: ArtifactCursorQuery,
      cursor: string | undefined,
    ): string | undefined {
      if (cursor === undefined) return undefined;
      try {
        if (cursor.length > 2_048) throw new Error('invalid');
        const parts = cursor.split('.');
        if (parts.length !== 4 || parts[0] !== 'aocur1')
          throw new Error('invalid');
        const secret = keys.get(parts[1] ?? '');
        if (secret === undefined) throw new Error('invalid');
        const supplied = decodePart(parts[3] ?? '');
        const signed = parts.slice(0, 3).join('.');
        const expected = signature(secret, signed);
        if (
          supplied.byteLength !== expected.byteLength ||
          !timingSafeEqual(supplied, expected)
        )
          throw new Error('invalid');
        const bytes = decodePart(parts[2] ?? '');
        if (bytes.byteLength > 1_536) throw new Error('invalid');
        const value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        ) as unknown;
        const after =
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          typeof (value as { after?: unknown }).after === 'string'
            ? (value as { after: string }).after
            : '';
        const expectedPayload = payload(query, after);
        if (JSON.stringify(value) !== JSON.stringify(expectedPayload))
          throw new Error('invalid');
        return expectedPayload.after;
      } catch {
        throw new ArtifactValidationError(
          'artifact list cursor is invalid for this query',
        );
      }
    },
  });
}
