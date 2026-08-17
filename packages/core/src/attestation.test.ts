import { describe, expect, it } from 'vitest';

import { createAttestationAuthority } from './attestation.js';

describe('opaque attestation authority', () => {
  it('accepts only tokens issued by the matching authority', () => {
    const authority = createAttestationAuthority<{ readonly value: string }>();
    const other = createAttestationAuthority<{ readonly value: string }>();
    const token = authority.issuer.issue({ value: 'trusted' });

    expect(authority.verifier.verify(token)).toEqual({ value: 'trusted' });
    expect(
      authority.verifier.verify(other.issuer.issue({ value: 'trusted' })),
    ).toBeUndefined();
    expect(authority.verifier.verify({ value: 'trusted' })).toBeUndefined();
  });
});
