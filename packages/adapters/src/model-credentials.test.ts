import { randomBytes } from 'node:crypto';

import { sealSecret, type ProviderCredential } from '@agentos/core';
import { describe, expect, it } from 'vitest';

import {
  ModelCredentialError,
  createModelCredentialResolver,
  providerCredentialPurpose,
} from './model-credentials.js';

const key = randomBytes(32);
const secretKey = Buffer.from(key).toString('base64url');
const anthropic = {
  id: 'anthropic',
  label: 'Anthropic',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseUrlEnv: 'ANTHROPIC_BASE_URL',
  defaultBaseUrl: 'https://api.anthropic.com',
};

const repositoryWith = (credential?: ProviderCredential) => ({
  getProviderCredential: async () => credential,
});

const storedKey = (plaintext: string): ProviderCredential => ({
  providerId: 'anthropic',
  sealedApiKey: sealSecret(
    key,
    plaintext,
    providerCredentialPurpose('anthropic'),
  ),
  hint: plaintext.slice(-4),
  updatedAt: '2026-09-03T12:00:00.000Z' as ProviderCredential['updatedAt'],
});

describe('model credential resolver', () => {
  it('prefers a stored key over the environment', async () => {
    // The stored one is what the operator set most recently and what the UI
    // reports; a stale shell variable must not quietly override it.
    const resolve = createModelCredentialResolver({
      repository: repositoryWith(storedKey('sk-ant-stored-key')),
      environment: {
        ANTHROPIC_API_KEY: 'sk-ant-from-env',
        AGENTOS_SECRET_KEY: secretKey,
      },
    });
    await expect(resolve(anthropic)).resolves.toMatchObject({
      apiKey: 'sk-ant-stored-key',
      source: 'database',
    });
  });

  it('falls back to the environment when nothing is stored', async () => {
    const resolve = createModelCredentialResolver({
      repository: repositoryWith(undefined),
      environment: { ANTHROPIC_API_KEY: 'sk-ant-from-env' },
    });
    await expect(resolve(anthropic)).resolves.toMatchObject({
      apiKey: 'sk-ant-from-env',
      source: 'environment',
    });
  });

  it('reports no credential rather than an empty one', async () => {
    const resolve = createModelCredentialResolver({
      repository: repositoryWith(undefined),
      environment: { ANTHROPIC_API_KEY: '   ' },
    });
    await expect(resolve(anthropic)).resolves.toBeUndefined();
  });

  it('says so when a stored key cannot be read', async () => {
    // Silently falling back to the environment would run on a credential the
    // operator believes they replaced.
    const resolve = createModelCredentialResolver({
      repository: repositoryWith(storedKey('sk-ant-stored-key')),
      environment: { ANTHROPIC_API_KEY: 'sk-ant-from-env' },
    });
    await expect(resolve(anthropic)).rejects.toThrow(ModelCredentialError);
  });

  it('reads the key again on every request', async () => {
    // Composition happens once per process. A cached credential would mean a
    // key added or rotated in the UI needed a restart to take effect.
    let current = 'sk-ant-first';
    const resolve = createModelCredentialResolver({
      repository: {
        getProviderCredential: async () => storedKey(current),
      },
      environment: { AGENTOS_SECRET_KEY: secretKey },
    });
    await expect(resolve(anthropic)).resolves.toMatchObject({
      apiKey: 'sk-ant-first',
    });
    current = 'sk-ant-rotated';
    await expect(resolve(anthropic)).resolves.toMatchObject({
      apiKey: 'sk-ant-rotated',
    });
  });
});
