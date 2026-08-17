import { describe, expect, it } from 'vitest';

import {
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  type SignedAttestation,
} from './attestation.js';

const key = {
  keyId: 'primary',
  secret: '0123456789abcdef0123456789abcdef',
} as const;
const expected = { kind: 'test-result', subject: 'criterion-1' } as const;

describe('signed attestation authority', () => {
  it('survives JSON persistence and verifier process reconstruction', () => {
    const token = createHmacAttestationIssuer<{ readonly value: string }>({
      ...key,
      kind: expected.kind,
    }).issue({
      subject: expected.subject,
      claims: { value: 'trusted' },
      issuedAt: '2026-08-16T20:00:00.000Z',
    });
    const persisted = JSON.parse(JSON.stringify(token)) as SignedAttestation<{
      readonly value: string;
    }>;
    const reconstructedVerifier = createHmacAttestationVerifier<{
      readonly value: string;
    }>({ kind: expected.kind, keys: [key] });

    expect(
      reconstructedVerifier.verify(persisted, { subject: expected.subject }),
    ).toEqual({
      value: 'trusted',
    });
  });

  it('rejects wrong-authority and tampered attestations', () => {
    const token = createHmacAttestationIssuer<{ readonly value: string }>({
      ...key,
      kind: expected.kind,
    }).issue({
      subject: expected.subject,
      claims: { value: 'trusted' },
      issuedAt: '2026-08-16T20:00:00.000Z',
    });
    const verifier = createHmacAttestationVerifier<{
      readonly value: string;
    }>({ kind: expected.kind, keys: [key] });
    const wrongVerifier = createHmacAttestationVerifier<{
      readonly value: string;
    }>({
      kind: expected.kind,
      keys: [
        {
          keyId: key.keyId,
          secret: 'fedcba9876543210fedcba9876543210',
        },
      ],
    });

    expect(
      wrongVerifier.verify(token, { subject: expected.subject }),
    ).toBeUndefined();
    expect(
      verifier.verify(
        { ...token, claims: { value: 'tampered' } },
        { subject: expected.subject },
      ),
    ).toBeUndefined();
    expect(verifier.verify(token, { subject: 'criterion-2' })).toBeUndefined();
    expect(
      verifier.verify(
        { ...token, signature: '00' },
        { subject: expected.subject },
      ),
    ).toBeUndefined();
  });

  it.each(['', 'too-short'])(
    'rejects insufficient secret material',
    (secret) => {
      expect(() =>
        createHmacAttestationIssuer({
          keyId: 'short-secret',
          secret,
          kind: 'test-result',
        }),
      ).toThrow(/32 bytes/i);
      expect(() =>
        createHmacAttestationVerifier({
          kind: 'test-result',
          keys: [{ keyId: 'short-secret', secret }],
        }),
      ).toThrow(/32 bytes/i);
    },
  );

  it('binds an issuer to one purpose even when input injects another kind', () => {
    const issuer = createHmacAttestationIssuer<{ readonly value: string }>({
      ...key,
      kind: 'normalized-change',
    });
    const token = issuer.issue({
      kind: 'repository-draft-publication',
      subject: 'modify:safe.txt',
      claims: { value: 'trusted' },
      issuedAt: '2026-08-16T20:00:00.000Z',
    } as Parameters<typeof issuer.issue>[0]);

    expect(token.kind).toBe('normalized-change');
  });

  it('rejects cross-purpose tokens minted from the same master secret', () => {
    const token = createHmacAttestationIssuer<{ readonly value: string }>({
      ...key,
      kind: 'normalized-change',
    }).issue({
      subject: 'modify:safe.txt',
      claims: { value: 'trusted' },
      issuedAt: '2026-08-16T20:00:00.000Z',
    });
    const publisherVerifier = createHmacAttestationVerifier<{
      readonly value: string;
    }>({
      kind: 'repository-draft-publication',
      keys: [key],
    });

    expect(publisherVerifier.verify(token)).toBeUndefined();
  });

  it('keeps the verifier bound when caller configuration is mutated', () => {
    const token = createHmacAttestationIssuer<{ readonly value: string }>({
      ...key,
      kind: 'normalized-change',
    }).issue({
      subject: 'modify:safe.txt',
      claims: { value: 'trusted' },
      issuedAt: '2026-08-16T20:00:00.000Z',
    });
    const options = { kind: 'normalized-change', keys: [key] };
    const verifier = createHmacAttestationVerifier<{
      readonly value: string;
    }>(options);
    options.kind = 'repository-draft-publication';

    expect(verifier.verify(token)).toEqual({ value: 'trusted' });
  });
});
