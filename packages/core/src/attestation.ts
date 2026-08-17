declare const attestationBrand: unique symbol;

export interface OpaqueAttestation<Claims> {
  readonly [attestationBrand]: Claims;
}

export interface AttestationIssuer<Claims> {
  issue(claims: Claims): OpaqueAttestation<Claims>;
}

export interface AttestationVerifier<Claims> {
  verify(attestation: unknown): Claims | undefined;
}

export interface AttestationAuthority<Claims> {
  readonly issuer: AttestationIssuer<Claims>;
  readonly verifier: AttestationVerifier<Claims>;
}

export function createAttestationAuthority<
  Claims,
>(): AttestationAuthority<Claims> {
  const issued = new WeakMap<object, Claims>();
  return Object.freeze({
    issuer: Object.freeze({
      issue(claims: Claims): OpaqueAttestation<Claims> {
        const token = Object.freeze(
          Object.create(null),
        ) as OpaqueAttestation<Claims>;
        issued.set(token, claims);
        return token;
      },
    }),
    verifier: Object.freeze({
      verify(attestation: unknown): Claims | undefined {
        return typeof attestation === 'object' && attestation !== null
          ? issued.get(attestation)
          : undefined;
      },
    }),
  });
}
