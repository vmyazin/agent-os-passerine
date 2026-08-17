import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface AttestationIdentity {
  readonly kind: string;
  readonly subject: string;
}

export interface AttestationVerifier<Claims> {
  verify(
    attestation: unknown,
    expected?: AttestationIdentity,
  ): Claims | undefined;
}

export interface AttestationAuthority<Claims> {
  readonly issuer: AttestationIssuer<Claims>;
  readonly verifier: AttestationVerifier<Claims>;
}

export interface SignedAttestation<Claims> extends AttestationIdentity {
  readonly version: 1;
  readonly keyId: string;
  readonly claims: Claims;
  readonly claimHash: string;
  readonly issuedAt: string;
  readonly signature: string;
}

export interface SignedAttestationIssue<Claims> extends AttestationIdentity {
  readonly claims: Claims;
  readonly issuedAt: string;
}

export interface AttestationIssuer<Claims> {
  issue(request: SignedAttestationIssue<Claims>): SignedAttestation<Claims>;
}

export type SignedAttestationIssuer<Claims> = AttestationIssuer<Claims>;

export interface HmacAttestationKey {
  readonly keyId: string;
  readonly secret: string | Uint8Array;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Attestation claims must contain only finite numbers');
    return value;
  }
  if (typeof value !== 'object')
    throw new Error('Attestation claims must be JSON serializable');
  if (ancestors.has(value))
    throw new Error('Attestation claims must not contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((entry) => canonicalize(entry, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error('Attestation claims must use plain JSON objects');
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, canonicalize(entry, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim() === '') throw new Error(`${label} must be non-empty`);
  return value;
}

function normalizeIssuedAt(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Error('issuedAt must be a valid timestamp');
  return new Date(milliseconds).toISOString();
}

function hashClaims(claims: unknown): string {
  return createHash('sha256').update(canonicalJson(claims)).digest('hex');
}

function signaturePayload(attestation: {
  readonly version: 1;
  readonly keyId: string;
  readonly kind: string;
  readonly subject: string;
  readonly claimHash: string;
  readonly issuedAt: string;
}): string {
  return canonicalJson(attestation);
}

function sign(secret: HmacAttestationKey['secret'], payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function createHmacAttestationIssuer<Claims>(
  key: HmacAttestationKey,
): AttestationIssuer<Claims> {
  const keyId = requireNonEmpty(key.keyId, 'keyId');
  return Object.freeze({
    issue(request: SignedAttestationIssue<Claims>): SignedAttestation<Claims> {
      const kind = requireNonEmpty(request.kind, 'kind');
      const subject = requireNonEmpty(request.subject, 'subject');
      const issuedAt = normalizeIssuedAt(request.issuedAt);
      const claimHash = hashClaims(request.claims);
      const signed = {
        version: 1,
        keyId,
        kind,
        subject,
        claimHash,
        issuedAt,
      } as const;
      return Object.freeze({
        ...signed,
        claims: request.claims,
        signature: sign(key.secret, signaturePayload(signed)),
      });
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function constantTimeSignatureMatches(
  actual: unknown,
  expected: string,
): boolean {
  if (typeof actual !== 'string' || !/^[0-9a-f]{64}$/.test(actual))
    return false;
  return timingSafeEqual(
    Buffer.from(actual, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}

export function createHmacAttestationVerifier<Claims>(options: {
  readonly keys: readonly HmacAttestationKey[];
}): AttestationVerifier<Claims> {
  const keys = new Map<string, HmacAttestationKey['secret']>();
  for (const key of options.keys) {
    const keyId = requireNonEmpty(key.keyId, 'keyId');
    if (keys.has(keyId))
      throw new Error(`Duplicate attestation keyId: ${keyId}`);
    keys.set(keyId, key.secret);
  }
  return Object.freeze({
    verify(
      attestation: unknown,
      expected?: AttestationIdentity,
    ): Claims | undefined {
      if (!isRecord(attestation)) return undefined;
      const {
        version,
        keyId,
        kind,
        subject,
        claimHash,
        issuedAt,
        signature,
        claims,
      } = attestation;
      if (
        version !== 1 ||
        typeof keyId !== 'string' ||
        typeof kind !== 'string' ||
        typeof subject !== 'string' ||
        typeof claimHash !== 'string' ||
        typeof issuedAt !== 'string' ||
        (expected !== undefined &&
          (kind !== expected.kind || subject !== expected.subject))
      )
        return undefined;
      const secret = keys.get(keyId);
      if (secret === undefined) return undefined;
      try {
        if (
          normalizeIssuedAt(issuedAt) !== issuedAt ||
          hashClaims(claims) !== claimHash
        )
          return undefined;
        const payload = signaturePayload({
          version,
          keyId,
          kind,
          subject,
          claimHash,
          issuedAt,
        });
        const expectedSignature = sign(secret, payload);
        return constantTimeSignatureMatches(signature, expectedSignature)
          ? (claims as Claims)
          : undefined;
      } catch {
        return undefined;
      }
    },
  });
}

export function createHmacAttestationAuthority<Claims>(
  key: HmacAttestationKey,
): AttestationAuthority<Claims> {
  return Object.freeze({
    issuer: createHmacAttestationIssuer<Claims>(key),
    verifier: createHmacAttestationVerifier<Claims>({ keys: [key] }),
  });
}
