import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for secrets the control plane stores.
 *
 * The same construction the runtime handle sealer uses -- AES-256-GCM with a
 * random nonce and an authentication tag -- because the requirement is the
 * same: a value the database holds but must not be able to read, and must not
 * be able to alter undetected.
 *
 * The key never lives in the database. A dump of `provider_credentials` is
 * ciphertext and nothing else; reading it requires the environment's key as
 * well, which is the whole point of storing secrets this way.
 *
 * Every seal is bound to a purpose string through the cipher's additional
 * authenticated data, so a ciphertext cannot be moved from one row to another
 * -- swapping a cheap provider's key into an expensive provider's row fails
 * to open rather than silently sending the wrong credential.
 */

const VERSION = 'sealed-secret-v1';
/** Long enough for any provider key, short enough to bound a hostile write. */
const MAX_PLAINTEXT_BYTES = 8_192;

export class SecretSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretSealError';
  }
}

/** A 32-byte key, as the environment carries it. */
export function secretKeyFromBase64Url(value: string): Uint8Array {
  const key = Buffer.from(value.trim(), 'base64url');
  if (key.byteLength !== 32)
    throw new SecretSealError('secret key must decode to 32 bytes');
  return key;
}

export function sealSecret(
  key: Uint8Array,
  plaintext: string,
  purpose: string,
): string {
  if (key.byteLength !== 32)
    throw new SecretSealError('secret key must be 32 bytes');
  if (plaintext.length === 0)
    throw new SecretSealError('secret must not be empty');
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES)
    throw new SecretSealError('secret is too large to seal');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.from(
    JSON.stringify({
      version: VERSION,
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    }),
    'utf8',
  ).toString('base64url');
}

/**
 * Recovers a sealed secret, or throws.
 *
 * Every failure -- a wrong key, a tampered ciphertext, a value sealed for a
 * different purpose -- is one error that says nothing about which, because
 * the difference is only useful to someone probing.
 */
export function openSecret(
  key: Uint8Array,
  sealed: string,
  purpose: string,
): string {
  if (key.byteLength !== 32)
    throw new SecretSealError('secret key must be 32 bytes');
  let envelope: {
    version?: unknown;
    iv?: unknown;
    ciphertext?: unknown;
    tag?: unknown;
  };
  try {
    envelope = JSON.parse(
      Buffer.from(sealed, 'base64url').toString('utf8'),
    ) as typeof envelope;
  } catch {
    throw new SecretSealError('sealed secret is invalid');
  }
  if (
    envelope.version !== VERSION ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.tag !== 'string'
  )
    throw new SecretSealError('sealed secret is invalid');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key),
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretSealError('sealed secret is invalid');
  }
}

/**
 * The tail of a secret, for telling two of them apart in the UI.
 *
 * Four characters is enough for an operator to recognise which key they
 * pasted and far short of enough to reconstruct it. A secret too short to
 * hint at is shown as nothing rather than as most of itself.
 */
export function secretHint(plaintext: string): string {
  return plaintext.length < 12 ? '' : plaintext.slice(-4);
}
