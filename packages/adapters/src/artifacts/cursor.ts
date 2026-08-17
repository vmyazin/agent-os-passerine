import {
  ArtifactValidationError,
  artifactKeyMatchesScope,
  artifactScopePrefix,
  parseArtifactKey,
  type ArtifactScope,
} from '@agentos/core';

interface CursorPayload {
  readonly v: 1;
  readonly scope: string;
  readonly after: string;
}

export function encodeArtifactCursor(
  scope: ArtifactScope,
  after: string,
): string {
  parseArtifactKey(after);
  if (!artifactKeyMatchesScope(after, scope))
    throw new ArtifactValidationError(
      'artifact cursor is outside the requested scope',
    );
  const payload: CursorPayload = {
    v: 1,
    scope: artifactScopePrefix(scope),
    after,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeArtifactCursor(
  scope: ArtifactScope,
  cursor: string | undefined,
): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid');
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor || bytes.byteLength > 1_536)
      throw new Error('invalid');
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      (value as CursorPayload).v !== 1 ||
      (value as CursorPayload).scope !== artifactScopePrefix(scope) ||
      typeof (value as CursorPayload).after !== 'string' ||
      !artifactKeyMatchesScope((value as CursorPayload).after, scope)
    )
      throw new Error('invalid');
    return (value as CursorPayload).after;
  } catch {
    throw new ArtifactValidationError(
      'artifact list cursor is invalid for this scope',
    );
  }
}
