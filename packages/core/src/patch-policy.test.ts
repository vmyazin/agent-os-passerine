import { describe, expect, it } from 'vitest';

import {
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
} from './attestation.js';
import {
  evaluatePatchPolicy,
  type ChangeManifest,
  type NormalizedChangeClaims,
} from './patch-policy.js';

const metadataKey = {
  keyId: 'manifest',
  secret: 'manifest-secret-material-32-bytes!',
} as const;
const metadataIssuer = createHmacAttestationIssuer<NormalizedChangeClaims>({
  ...metadataKey,
  kind: 'normalized-change',
});
const metadataVerifier = createHmacAttestationVerifier<NormalizedChangeClaims>({
  kind: 'normalized-change',
  keys: [metadataKey],
});

const decodedPath = (path: string): string => {
  let decoded = path;
  try {
    for (let pass = 0; pass < 16; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
  } catch {
    return path;
  }
  return decoded;
};

const change = (
  path: string,
  overrides: Partial<ChangeManifest['changes'][number]> = {},
) => {
  const fields = {
    path,
    operation: 'modify' as const,
    sizeBytes: 10,
    binary: false,
    symlink: false,
    ...overrides,
  };
  const metadataAttestation = metadataIssuer.issue({
    subject: `${fields.operation}:${decodedPath(fields.path)}`,
    claims: {
      path: fields.path,
      operation: fields.operation,
      sizeBytes: fields.sizeBytes,
      binary: fields.binary,
      symlink: fields.symlink,
    },
    issuedAt: '2026-08-16T20:00:00.000Z',
  });
  return {
    ...fields,
    metadataAttestation: JSON.parse(JSON.stringify(metadataAttestation)),
  };
};

const evaluate = (changes: ChangeManifest['changes'], options = {}) =>
  evaluatePatchPolicy(
    { baseSha: 'abc123', changes },
    { currentBaseSha: 'abc123', ...options },
    metadataVerifier,
  );

describe('patch policy', () => {
  it.each([
    '.github/workflows/release.yml',
    'CODEOWNERS',
    'docs/CODEOWNERS',
    '.gitmodules',
    '.env',
    '.env.local',
    'apps/web/.env.test',
    'agentos/example.yaml',
  ])('blocks protected path %s by default', (path) => {
    expect(evaluate([change(path)]).violations[0]?.code).toBe('protected_path');
  });

  it('rejects stale base SHA, symlinks, binaries, oversized files, and malformed paths', () => {
    const result = evaluatePatchPolicy(
      {
        baseSha: 'stale',
        changes: [
          change('link', { symlink: true }),
          change('asset.bin', { binary: true }),
          change('huge.txt', { sizeBytes: 1_000_001 }),
          change('../escape.txt'),
          change('/absolute.txt'),
          change('windows\\path.txt'),
        ],
      },
      { currentBaseSha: 'current' },
      metadataVerifier,
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.map(({ code }) => code)).toEqual([
      'stale_base',
      'symlink',
      'binary',
      'oversized',
      'malformed_path',
      'malformed_path',
      'malformed_path',
    ]);
  });

  it('allows binary files and symlinks only when explicitly enabled', () => {
    expect(
      evaluate(
        [
          change('asset.bin', { binary: true }),
          change('link', { symlink: true }),
        ],
        { allowBinary: true, allowSymlinks: true },
      ).allowed,
    ).toBe(true);
  });

  it.each(['unsafe%00name', 'dir%5Cfile.txt', '%2e%2e/escape.txt'])(
    'rejects encoded malformed path %s after decoding',
    (path) => {
      expect(evaluate([change(path)]).violations[0]?.code).toBe(
        'malformed_path',
      );
    },
  );

  it.each([
    '%2eenv',
    '.github%2Fworkflows/release.yml',
    'agentos%2Fexample.yaml',
    '%25252525252eenv',
  ])('matches protected path %s after decoding', (path) => {
    expect(evaluate([change(path)]).violations[0]?.code).toBe('protected_path');
  });

  it.each([
    'Agentos/example.yaml',
    '.GITHUB/WORKFLOWS/release.yml',
    'codeowners',
    'docs/CodeOwners',
  ])('blocks protected case variant %s', (path) => {
    expect(evaluate([change(path)]).violations[0]?.code).toBe('protected_path');
  });

  it.each([
    {
      path: 'missing-binary.txt',
      operation: 'modify',
      sizeBytes: 10,
      symlink: false,
    },
    {
      path: 'missing-symlink.txt',
      operation: 'modify',
      sizeBytes: 10,
      binary: false,
    },
    {
      path: 'missing-size.txt',
      operation: 'modify',
      binary: false,
      symlink: false,
    },
    {
      path: 'untrusted.txt',
      operation: 'modify',
      sizeBytes: 10,
      binary: false,
      symlink: false,
      metadataTrusted: false,
    },
  ])(
    'fails closed on missing or untrusted change metadata',
    (untrustedChange) => {
      const result = evaluate([
        untrustedChange as unknown as ChangeManifest['changes'][number],
      ]);
      expect(result.violations[0]?.code).toBe('untrusted_metadata');
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5])(
    'rejects invalid max file limit %s',
    (maxFileBytes) => {
      expect(() => evaluate([change('safe.txt')], { maxFileBytes })).toThrow(
        /limit/i,
      );
    },
  );

  it('rejects structural and cross-authority metadata attestations', () => {
    const other = createHmacAttestationIssuer<NormalizedChangeClaims>({
      keyId: metadataKey.keyId,
      secret: 'different-manifest-secret-material!',
      kind: 'normalized-change',
    });
    const trustedShape = change('safe.txt');
    const forged = {
      ...trustedShape,
      metadataAttestation: other.issue({
        subject: 'modify:safe.txt',
        claims: {
          path: trustedShape.path,
          operation: trustedShape.operation,
          sizeBytes: trustedShape.sizeBytes,
          binary: trustedShape.binary,
          symlink: trustedShape.symlink,
        },
        issuedAt: '2026-08-16T20:00:00.000Z',
      }),
    };

    const result = evaluatePatchPolicy(
      { baseSha: 'abc123', changes: [forged] },
      { currentBaseSha: 'abc123' },
      metadataVerifier,
    );
    expect(result.violations[0]?.code).toBe('untrusted_metadata');
  });

  it('binds persisted metadata attestations to the change kind and subject', () => {
    const key = {
      keyId: 'manifest',
      secret: 'manifest-secret-material-32-bytes!',
    } as const;
    const issuer = createHmacAttestationIssuer<NormalizedChangeClaims>({
      ...key,
      kind: 'normalized-change',
    });
    const verifier = createHmacAttestationVerifier<NormalizedChangeClaims>({
      kind: 'normalized-change',
      keys: [key],
    });
    const fields = {
      path: 'safe.txt',
      operation: 'modify' as const,
      sizeBytes: 10,
      binary: false,
      symlink: false,
    };
    const wrongSubject = JSON.parse(
      JSON.stringify(
        issuer.issue({
          subject: 'modify:other.txt',
          claims: fields,
          issuedAt: '2026-08-16T20:00:00.000Z',
        }),
      ),
    );

    const result = evaluatePatchPolicy(
      {
        baseSha: 'abc123',
        changes: [
          {
            ...fields,
            metadataAttestation: wrongSubject,
          } as ChangeManifest['changes'][number],
        ],
      },
      { currentBaseSha: 'abc123' },
      verifier,
    );

    expect(result.violations[0]?.code).toBe('untrusted_metadata');
  });
});
