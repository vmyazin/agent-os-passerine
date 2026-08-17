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
});
