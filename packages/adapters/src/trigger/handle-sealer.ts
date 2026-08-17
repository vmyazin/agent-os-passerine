import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { canonicalJsonValue, type RuntimeHandle } from '@agentos/core';
import { z } from 'zod';

import type { WorkflowHandleSealer } from './types.js';

const envelopeSchema = z
  .object({
    version: z.literal('sealed-runtime-handle-v1'),
    iv: z.string().min(16).max(32),
    ciphertext: z.string().min(1).max(16_384),
    tag: z.string().min(16).max(32),
  })
  .strict();

export function createAesWorkflowHandleSealer(
  key: Uint8Array,
): WorkflowHandleSealer {
  if (key.byteLength !== 32)
    throw new Error('runtime handle sealing key must be 32 bytes');
  const secret = Buffer.from(key);
  return Object.freeze({
    async seal(
      handle: Parameters<WorkflowHandleSealer['seal']>[0],
      aad: Parameters<WorkflowHandleSealer['seal']>[1],
    ) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      cipher.setAAD(Buffer.from(canonicalJsonValue(aad)));
      const ciphertext = Buffer.concat([
        cipher.update(canonicalJsonValue(handle)),
        cipher.final(),
      ]);
      return Buffer.from(
        JSON.stringify({
          version: 'sealed-runtime-handle-v1',
          iv: iv.toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
        }),
      ).toString('base64url');
    },
    async open(
      sealed: Parameters<WorkflowHandleSealer['open']>[0],
      aad: Parameters<WorkflowHandleSealer['open']>[1],
    ) {
      let envelope: z.infer<typeof envelopeSchema>;
      try {
        envelope = envelopeSchema.parse(
          JSON.parse(Buffer.from(sealed, 'base64url').toString('utf8')),
        );
      } catch {
        throw new Error('sealed runtime handle is invalid');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        secret,
        Buffer.from(envelope.iv, 'base64url'),
      );
      decipher.setAAD(Buffer.from(canonicalJsonValue(aad)));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      let value: unknown;
      try {
        value = JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
            decipher.final(),
          ]).toString('utf8'),
        );
      } catch {
        throw new Error('sealed runtime handle authentication failed');
      }
      if (
        typeof value !== 'object' ||
        value === null ||
        typeof Reflect.get(value, 'id') !== 'string'
      ) {
        throw new Error('sealed runtime handle payload is invalid');
      }
      return value as RuntimeHandle;
    },
  });
}

export function workflowHandleSealingKeyFromEnv(
  value: string | undefined,
): Uint8Array {
  if (value === undefined)
    throw new Error('RUNTIME_HANDLE_SEALING_KEY is required');
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength !== 32)
    throw new Error('RUNTIME_HANDLE_SEALING_KEY must encode exactly 32 bytes');
  return key;
}
