import { describe, expect, it } from 'vitest';

import {
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  type SignedAttestation,
} from './attestation.js';

const key = { keyId: 'primary', secret: 'test-only-secret' } as const;
const expected = { kind: 'test-result', subject: 'criterion-1' } as const;

describe('signed attestation authority', () => {
  it('survives JSON persistence and verifier process reconstruction', () => {
    const token = createHmacAttestationIssuer<{ readonly value: string }>(
      key,
    ).issue({
      ...expected,
      claims: { value: 'trusted' },
      issuedAt: '2026-08-16T20:00:00.000Z',
    });
    const persisted = JSON.parse(JSON.stringify(token)) as SignedAttestation<{
      readonly value: string;
    }>;
    const reconstructedVerifier = createHmacAttestationVerifier<{
      readonly value: string;
    }>({ keys: [key] });

    expect(reconstructedVerifier.verify(persisted, expected)).toEqual({
      value: 'trusted',
    });
  });

  it('rejects wrong-authority and tampered attestations', () => {
    const token = createHmacAttestationIssuer<{ readonly value: string }>(
      key,
    ).issue({
      ...expected,
      claims: { value: 'trusted' },
      issuedAt: '2026-08-16T20:00:00.000Z',
    });
    const verifier = createHmacAttestationVerifier<{
      readonly value: string;
    }>({ keys: [key] });
    const wrongVerifier = createHmacAttestationVerifier<{
      readonly value: string;
    }>({
      keys: [{ keyId: key.keyId, secret: 'different-secret' }],
    });

    expect(wrongVerifier.verify(token, expected)).toBeUndefined();
    expect(
      verifier.verify({ ...token, claims: { value: 'tampered' } }, expected),
    ).toBeUndefined();
    expect(
      verifier.verify(token, { ...expected, subject: 'criterion-2' }),
    ).toBeUndefined();
    expect(
      verifier.verify({ ...token, signature: '00' }, expected),
    ).toBeUndefined();
  });
});
