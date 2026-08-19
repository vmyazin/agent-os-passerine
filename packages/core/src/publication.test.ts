import { describe, expect, it } from 'vitest';

import {
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
} from './attestation.js';
import {
  canonicalPublicationPolicyDigest,
  canonicalPublicationManifestDigest,
  DEFAULT_PUBLICATION_POLICY,
  evaluatePublicationPolicy,
  isLocalRepository,
  normalizePublicationPolicySnapshot,
  parsePublicationManifest,
  publicationRepositorySchema,
  validatePublicationAuthorization,
  type PublicationAuthorizationClaims,
  type PublicationManifestBody,
} from './publication.js';

const DIGEST = 'a'.repeat(64);
const BASE_SHA = 'b'.repeat(40);
const now = new Date('2026-08-17T12:00:00.000Z');
const key = {
  keyId: 'publisher-2026-08',
  secret: 'publisher-authorization-secret-32-bytes',
} as const;
const issuer = createHmacAttestationIssuer<PublicationAuthorizationClaims>({
  ...key,
  kind: 'github-publication',
});
const verifier = createHmacAttestationVerifier<PublicationAuthorizationClaims>({
  kind: 'github-publication',
  keys: [key],
});

function body(
  overrides: Partial<PublicationManifestBody> = {},
): PublicationManifestBody {
  return {
    version: 'publication-manifest-v1',
    projectId: 'project-1',
    runId: 'run-1',
    stepId: 'publish-1',
    repository: {
      owner: 'team-zork',
      name: 'passerine',
      installationId: 42,
      repositoryId: 314159,
    },
    expectedBase: { branch: 'main', sha: BASE_SHA },
    configDigest: DIGEST,
    policyDigest: 'c'.repeat(64),
    sourceSnapshotDigest: 'd'.repeat(64),
    testEvidence: [
      {
        kind: 'test-report',
        artifactDigest: 'e'.repeat(64),
      },
    ],
    changes: [
      {
        operation: 'modify',
        path: 'src/index.ts',
        mode: '100644',
        content: 'export const answer = 42;\n',
      },
    ],
    ...overrides,
  };
}

function authorize(manifest: PublicationManifestBody) {
  const manifestDigest = canonicalPublicationManifestDigest(manifest);
  return issuer.issue({
    subject: `${manifest.projectId}:${manifest.runId}:${manifestDigest}`,
    issuedAt: '2026-08-17T11:59:00.000Z',
    claims: {
      purpose: 'publish-draft-pr',
      audience: 'github-publisher',
      projectId: manifest.projectId,
      runId: manifest.runId,
      stepId: manifest.stepId,
      repository: manifest.repository,
      expectedBase: manifest.expectedBase,
      configDigest: manifest.configDigest,
      policyDigest: manifest.policyDigest,
      sourceSnapshotDigest: manifest.sourceSnapshotDigest,
      testEvidenceDigest: canonicalPublicationManifestDigest(
        manifest.testEvidence,
      ),
      manifestDigest,
      nonce: 'authorization-nonce-1',
      expiresAt: '2026-08-17T12:05:00.000Z',
    },
  });
}

describe('publication manifest', () => {
  it('canonically binds a restrictive policy snapshot without removable defaults', () => {
    const custom = normalizePublicationPolicySnapshot({
      ...DEFAULT_PUBLICATION_POLICY,
      protectedPaths: [
        ...DEFAULT_PUBLICATION_POLICY.protectedPaths,
        'secrets/**',
      ],
      maxFiles: 3,
      maxFileBytes: 128,
      maxTotalBytes: 256,
      allowDeletes: false,
    });
    expect(canonicalPublicationPolicyDigest(custom)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      canonicalPublicationPolicyDigest({
        ...custom,
        protectedPaths: [...custom.protectedPaths].reverse(),
      }),
    ).toBe(canonicalPublicationPolicyDigest(custom));
    expect(() =>
      normalizePublicationPolicySnapshot({
        ...DEFAULT_PUBLICATION_POLICY,
        protectedPaths: [],
      }),
    ).toThrow(/default protected/i);
  });

  it('applies custom deny, mode, size, count, and delete rules to every operation', () => {
    const policy = normalizePublicationPolicySnapshot({
      ...DEFAULT_PUBLICATION_POLICY,
      protectedPaths: [
        ...DEFAULT_PUBLICATION_POLICY.protectedPaths,
        'private/**',
      ],
      allowedModes: ['100644'],
      maxFiles: 2,
      maxFileBytes: 8,
      maxTotalBytes: 10,
      allowDeletes: false,
    });
    for (const changes of [
      [
        {
          operation: 'add',
          path: 'private/new.ts',
          mode: '100644',
          content: 'safe',
        },
      ],
      [
        {
          operation: 'modify',
          path: 'src/index.ts',
          mode: '100755',
          content: 'safe',
        },
      ],
      [{ operation: 'delete', path: 'src/old.ts' }],
    ] as const) {
      expect(() =>
        evaluatePublicationPolicy(
          body({
            changes: changes as unknown as PublicationManifestBody['changes'],
          }).changes,
          policy,
        ),
      ).toThrow(/policy/i);
    }
  });

  it('parses a strict full-file change set and hashes it canonically', () => {
    const input = body();
    const parsed = parsePublicationManifest({
      manifest: input,
      authorization: authorize(input),
    });

    expect(parsed.manifest.changes).toEqual(input.changes);
    expect(parsed.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.manifestDigest).toBe(
      canonicalPublicationManifestDigest(JSON.parse(JSON.stringify(input))),
    );
  });

  it.each([
    '../escape.ts',
    '%2e%2e/escape.ts',
    '/absolute.ts',
    'windows\\path.ts',
    'unsafe\0name.ts',
    'src\u202Eevil.ts',
    'src/e\u0301.ts',
    'src/café.ts',
    '.git/config',
    '.github/workflows/release.yml',
    'nested/CODEOWNERS',
    '.gitmodules',
    '.env.production',
    'agentos/project.yaml',
  ])('rejects malicious or protected path %s', (path) => {
    const manifest = body({
      changes: [
        {
          operation: 'modify',
          path,
          mode: '100644',
          content: 'safe',
        },
      ],
    });
    expect(() =>
      parsePublicationManifest({
        manifest,
        authorization: authorize(manifest),
      }),
    ).toThrow(/path|protected/i);
  });

  it('rejects case-insensitive collisions, binary content, invalid modes, and excessive aggregate size', () => {
    const colliding = body({
      changes: [
        { operation: 'add', path: 'src/New.ts', mode: '100644', content: 'a' },
        { operation: 'add', path: 'SRC/new.ts', mode: '100644', content: 'b' },
      ],
    });
    expect(() =>
      parsePublicationManifest({
        manifest: colliding,
        authorization: authorize(colliding),
      }),
    ).toThrow(/collision/i);

    for (const changes of [
      [
        {
          operation: 'add',
          path: 'binary.txt',
          mode: '100644',
          content: 'a\0b',
        },
      ],
      [
        {
          operation: 'add',
          path: 'link',
          mode: '120000',
          content: 'target',
        },
      ],
      [
        {
          operation: 'add',
          path: 'huge.txt',
          mode: '100644',
          content: 'x'.repeat(1_000_001),
        },
      ],
    ]) {
      const manifest = body({
        changes: changes as PublicationManifestBody['changes'],
      });
      expect(() =>
        parsePublicationManifest({
          manifest,
          authorization: authorize(manifest),
        }),
      ).toThrow();
    }
  });

  it('rejects file and directory shape conflicts inside the change set', () => {
    const conflicting = body({
      changes: [
        {
          operation: 'add',
          path: 'src/generated',
          mode: '100644',
          content: 'file',
        },
        {
          operation: 'add',
          path: 'src/generated/index.ts',
          mode: '100644',
          content: 'nested',
        },
      ],
    });
    expect(() =>
      parsePublicationManifest({
        manifest: conflicting,
        authorization: authorize(conflicting),
      }),
    ).toThrow(/shape/i);
  });

  it('models rename only as a delete plus add and rejects forbidden deletes', () => {
    const rename = body({
      changes: [
        { operation: 'delete', path: 'src/old.ts' },
        {
          operation: 'add',
          path: 'src/new.ts',
          mode: '100644',
          content: 'new',
        },
      ],
    });
    expect(
      parsePublicationManifest({
        manifest: rename,
        authorization: authorize(rename),
      }).manifest.changes,
    ).toHaveLength(2);

    const forbidden = body({
      changes: [{ operation: 'delete', path: 'CODEOWNERS' }],
    });
    expect(() =>
      parsePublicationManifest({
        manifest: forbidden,
        authorization: authorize(forbidden),
      }),
    ).toThrow(/protected/i);
  });

  it('verifies a purpose-bound expiring publication authorization', () => {
    const manifest = body();
    const parsed = parsePublicationManifest({
      manifest,
      authorization: authorize(manifest),
    });
    expect(
      validatePublicationAuthorization(parsed, verifier, now),
    ).toMatchObject({ nonce: 'authorization-nonce-1' });

    const tampered = body({ runId: 'run-2' });
    const parsedTampered = parsePublicationManifest({
      manifest: tampered,
      authorization: authorize(manifest),
    });
    expect(() =>
      validatePublicationAuthorization(parsedTampered, verifier, now),
    ).toThrow(/authorization/i);

    expect(() =>
      validatePublicationAuthorization(
        parsed,
        verifier,
        new Date('2026-08-17T12:06:00.000Z'),
      ),
    ).toThrow(/expired/i);
  });

  it('rejects publication authorizations with an excessive validity window', () => {
    const manifest = body();
    const manifestDigest = canonicalPublicationManifestDigest(manifest);
    const authorization = issuer.issue({
      subject: `${manifest.projectId}:${manifest.runId}:${manifestDigest}`,
      issuedAt: '2026-08-17T11:59:00.000Z',
      claims: {
        ...authorize(manifest).claims,
        expiresAt: '2026-08-18T11:59:00.000Z',
      },
    });
    const parsed = parsePublicationManifest({ manifest, authorization });
    expect(() =>
      validatePublicationAuthorization(parsed, verifier, now),
    ).toThrow(/validity/i);
  });

  it('rejects unknown fields and unsafe repository identifiers', () => {
    const manifest = { ...body(), shell: 'git push --force' };
    expect(() =>
      parsePublicationManifest({
        manifest,
        authorization: authorize(manifest),
      }),
    ).toThrow();

    const branchInjection = body({
      expectedBase: { branch: 'main\nrefs/heads/evil', sha: BASE_SHA },
    });
    expect(() =>
      parsePublicationManifest({
        manifest: branchInjection,
        authorization: authorize(branchInjection),
      }),
    ).toThrow(/branch/i);
  });
});

describe('local repository identity', () => {
  it('accepts the local variant and narrows it', () => {
    const parsed = publicationRepositorySchema.parse({
      kind: 'local',
      owner: 'local',
      name: 'experiment-1',
    });
    expect(isLocalRepository(parsed)).toBe(true);
  });

  it('rejects local variants with GitHub identifiers', () => {
    expect(() =>
      publicationRepositorySchema.parse({
        kind: 'local',
        owner: 'local',
        name: 'x',
        repositoryId: 1,
      }),
    ).toThrow();
  });

  it('keeps rejecting GitHub identities without positive ids', () => {
    expect(() =>
      publicationRepositorySchema.parse({
        owner: 'octo',
        name: 'repo',
        installationId: 0,
        repositoryId: 1,
      }),
    ).toThrow();
  });
});
