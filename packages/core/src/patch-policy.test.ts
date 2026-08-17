import { describe, expect, it } from 'vitest';

import { evaluatePatchPolicy, type ChangeManifest } from './patch-policy.js';

const change = (
  path: string,
  overrides: Partial<ChangeManifest['changes'][number]> = {},
) => ({
  path,
  operation: 'modify' as const,
  sizeBytes: 10,
  binary: false,
  symlink: false,
  metadataTrusted: true as const,
  ...overrides,
});

const evaluate = (changes: ChangeManifest['changes'], options = {}) =>
  evaluatePatchPolicy(
    { baseSha: 'abc123', changes },
    { currentBaseSha: 'abc123', ...options },
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
});
