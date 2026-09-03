import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SecretSealError,
  openSecret,
  sealSecret,
  secretHint,
  secretKeyFromBase64Url,
} from './secret-box.js';

const key = randomBytes(32);
const other = randomBytes(32);

describe('secret box', () => {
  it('recovers what it sealed, under the same purpose', () => {
    const sealed = sealSecret(key, 'sk-ant-secret-value', 'provider:anthropic');
    expect(openSecret(key, sealed, 'provider:anthropic')).toBe(
      'sk-ant-secret-value',
    );
  });

  it('never puts the secret in the sealed form', () => {
    const sealed = sealSecret(key, 'sk-ant-secret-value', 'provider:anthropic');
    // The envelope travels through the database and the logs of anything
    // that touches it; the plaintext must not be recoverable by reading.
    expect(sealed).not.toContain('sk-ant');
    expect(Buffer.from(sealed, 'base64url').toString('utf8')).not.toContain(
      'sk-ant',
    );
  });

  it('refuses a ciphertext moved to another purpose', () => {
    // Swapping a cheap provider's key into an expensive provider's row must
    // fail to open, not silently send the wrong credential.
    const sealed = sealSecret(key, 'sk-ant-secret-value', 'provider:anthropic');
    expect(() => openSecret(key, sealed, 'provider:kimi')).toThrow(
      SecretSealError,
    );
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = sealSecret(key, 'sk-ant-secret-value', 'provider:anthropic');
    const envelope = JSON.parse(
      Buffer.from(sealed, 'base64url').toString('utf8'),
    ) as { ciphertext: string };
    const flipped = Buffer.from(
      JSON.stringify({
        ...envelope,
        ciphertext: Buffer.from(
          Buffer.from(envelope.ciphertext, 'base64url').map((byte, index) =>
            index === 0 ? byte ^ 1 : byte,
          ),
        ).toString('base64url'),
      }),
      'utf8',
    ).toString('base64url');
    expect(() => openSecret(key, flipped, 'provider:anthropic')).toThrow(
      SecretSealError,
    );
  });

  it('refuses the wrong key', () => {
    const sealed = sealSecret(key, 'sk-ant-secret-value', 'provider:anthropic');
    expect(() => openSecret(other, sealed, 'provider:anthropic')).toThrow(
      SecretSealError,
    );
  });

  it('seals the same secret differently every time', () => {
    // A random nonce per seal, so equal keys are not equal ciphertexts and
    // the database cannot be read for which providers share a credential.
    expect(sealSecret(key, 'sk-ant-secret-value', 'p')).not.toBe(
      sealSecret(key, 'sk-ant-secret-value', 'p'),
    );
  });

  it('reads a key from the environment encoding, and rejects a short one', () => {
    expect(
      secretKeyFromBase64Url(Buffer.from(key).toString('base64url')),
    ).toHaveLength(32);
    expect(() => secretKeyFromBase64Url('c2hvcnQ')).toThrow(SecretSealError);
  });

  it('hints at a long secret and says nothing about a short one', () => {
    expect(secretHint('sk-ant-0123456789abcd')).toBe('abcd');
    expect(secretHint('short')).toBe('');
  });
});
