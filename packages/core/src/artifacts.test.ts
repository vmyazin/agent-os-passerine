import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ArtifactValidationError,
  buildArtifactKey,
  normalizeArtifactListRequest,
  parseArtifactKey,
  prepareArtifactPut,
  validateArtifactMetadata,
} from './artifacts.js';

const scope = { projectId: 'project-1', runId: 'run-1', stepId: 'step-1' };
const bytes = new TextEncoder().encode('hello');
const digest = createHash('sha256').update(bytes).digest('hex');

describe('artifact contracts', () => {
  it('builds and parses a content-addressed scope-bound key', () => {
    const key = buildArtifactKey({
      ...scope,
      artifactId: 'spec',
      version: 2,
      digest,
    });

    expect(key).toBe(
      `artifacts/v1/project-1/run-1/step-1/spec/2/sha256/${digest}`,
    );
    expect(parseArtifactKey(key)).toEqual({
      ...scope,
      artifactId: 'spec',
      version: 2,
      digest,
    });
  });

  it.each([
    '../run',
    'run/other',
    'rún',
    'run%2fother',
    '.hidden',
    'run\\other',
  ])('rejects unsafe or non-canonical scope segment %s', (runId) => {
    expect(() =>
      buildArtifactKey({
        ...scope,
        runId,
        artifactId: 'spec',
        version: 1,
        digest,
      }),
    ).toThrow(ArtifactValidationError);
  });

  it('rejects malformed and non-canonical keys', () => {
    expect(() => parseArtifactKey(`artifacts//${digest}`)).toThrow(
      ArtifactValidationError,
    );
    expect(() =>
      parseArtifactKey(
        `artifacts/v1/project-1/run-1/step-1/spec/01/sha256/${digest}`,
      ),
    ).toThrow(ArtifactValidationError);
  });

  it('caps list page sizes and validates opaque cursor encoding', () => {
    expect(normalizeArtifactListRequest({ scope, limit: 1_000 }).limit).toBe(
      1_000,
    );
    expect(() => normalizeArtifactListRequest({ scope, limit: 1_001 })).toThrow(
      /limit/i,
    );
    expect(() =>
      normalizeArtifactListRequest({ scope, cursor: '../page' }),
    ).toThrow(/cursor/i);
  });

  it('validates digest, textual UTF-8, MIME, byte ceiling, and retention', () => {
    const prepared = prepareArtifactPut(
      {
        scope,
        artifactId: 'spec',
        version: 1,
        digest,
        bytes,
        mediaType: 'text/markdown; charset=utf-8',
        retentionClass: 'working',
      },
      new Date('2026-08-17T00:00:00.000Z'),
    );

    expect(prepared.key).toContain(digest);
    expect(prepared.sizeBytes).toBe(5);
    expect(prepared.expiresAt).toBe('2026-09-16T00:00:00.000Z');

    expect(() =>
      prepareArtifactPut(
        {
          scope,
          artifactId: prepared.artifactId,
          version: prepared.version,
          bytes,
          digest: '0'.repeat(64),
          mediaType: prepared.mediaType,
        },
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).toThrow(/digest/i);
    expect(() =>
      prepareArtifactPut(
        {
          scope,
          artifactId: prepared.artifactId,
          version: prepared.version,
          bytes: new Uint8Array([0xff]),
          mediaType: prepared.mediaType,
        },
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).toThrow(/UTF-8/i);
    expect(() =>
      prepareArtifactPut(
        {
          scope,
          artifactId: prepared.artifactId,
          version: prepared.version,
          bytes,
          mediaType: 'text/html',
        },
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).toThrow(/media type/i);
    expect(() =>
      prepareArtifactPut(
        {
          scope,
          artifactId: prepared.artifactId,
          version: prepared.version,
          bytes: new Uint8Array(17),
          mediaType: prepared.mediaType,
        },
        new Date('2026-08-17T00:00:00.000Z'),
        { maxBytes: 16 },
      ),
    ).toThrow(/large/i);
  });

  it('limits short-lived source and session artifacts to 24 hours', () => {
    for (const retentionClass of [
      'source-bundle',
      'cloud-session-upload',
    ] as const) {
      const artifact = prepareArtifactPut(
        {
          scope,
          artifactId: 'source',
          version: 1,
          bytes,
          mediaType: 'application/octet-stream',
          retentionClass,
        },
        new Date('2026-08-17T00:00:00.000Z'),
      );
      expect(artifact.expiresAt).toBe('2026-08-18T00:00:00.000Z');
    }
  });

  it('rejects untrusted retention metadata with an invalid class or window', () => {
    const prepared = prepareArtifactPut(
      {
        scope,
        artifactId: 'spec',
        version: 1,
        bytes,
        mediaType: 'text/plain',
      },
      new Date('2026-08-17T00:00:00.000Z'),
    );
    const { bytes: _content, ...metadata } = prepared;
    expect(_content).toEqual(bytes);
    expect(() =>
      validateArtifactMetadata({
        ...metadata,
        retentionClass: 'forever' as never,
      }),
    ).toThrow(/retention/i);
    expect(() =>
      validateArtifactMetadata({
        ...metadata,
        expiresAt: '2027-08-17T00:00:00.000Z',
      }),
    ).toThrow(/retention/i);
  });
});
