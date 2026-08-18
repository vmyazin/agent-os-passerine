import type { RuntimeFileResource } from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { createKimiLocalAccessStore } from './access.js';
import { createKimiRuntimeProviderFromEnv, kimiFromEnv } from './from-env.js';

const OWNERSHIP_SECRET = 'x'.repeat(32);
const ARTIFACT_MCP_URL = 'https://artifacts.example.test/mcp';

describe('kimiFromEnv', () => {
  it('is undefined for absent, blank, or whitespace-only KIMI_API_KEY', () => {
    expect(kimiFromEnv({})).toBeUndefined();
    expect(kimiFromEnv({ KIMI_API_KEY: '' })).toBeUndefined();
    expect(kimiFromEnv({ KIMI_API_KEY: '   ' })).toBeUndefined();
  });

  it('trims apiKey and baseUrl when present', () => {
    expect(
      kimiFromEnv({
        KIMI_API_KEY: '  k  ',
        KIMI_BASE_URL: '  https://kimi.example.test  ',
      }),
    ).toEqual({ apiKey: 'k', baseUrl: 'https://kimi.example.test' });
  });
});

describe('createKimiRuntimeProviderFromEnv', () => {
  it('returns undefined exactly when kimiFromEnv does', () => {
    const store = createKimiLocalAccessStore();
    expect(
      createKimiRuntimeProviderFromEnv(
        { KIMI_API_KEY: '' },
        {
          ownershipSecret: OWNERSHIP_SECRET,
          artifactMcpUrl: ARTIFACT_MCP_URL,
          store,
        },
      ),
    ).toBeUndefined();
  });

  it('builds a provider when KIMI_API_KEY is present', () => {
    const store = createKimiLocalAccessStore();
    const provider = createKimiRuntimeProviderFromEnv(
      { KIMI_API_KEY: 'test-key' },
      {
        ownershipSecret: OWNERSHIP_SECRET,
        artifactMcpUrl: ARTIFACT_MCP_URL,
        store,
      },
    );
    expect(provider).toBeDefined();
  });

  it('wires cleanupAccess to store.discard by default, mapping resources to fileIds', async () => {
    const store = createKimiLocalAccessStore();
    const discard = vi.spyOn(store, 'discard');
    const provider = createKimiRuntimeProviderFromEnv(
      { KIMI_API_KEY: 'test-key' },
      {
        ownershipSecret: OWNERSHIP_SECRET,
        artifactMcpUrl: ARTIFACT_MCP_URL,
        store,
      },
    )!;
    const resources: RuntimeFileResource[] = [
      { type: 'file', fileId: 'kimi-file-abc', mountPath: '/workspace/x' },
    ];
    await provider.cleanupAccess!({
      resources,
      credentialRefs: ['kimi-cred-abc'],
    });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith({
      fileIds: ['kimi-file-abc'],
      credentialRefs: ['kimi-cred-abc'],
    });
  });

  it('leaves cleanupAccess a no-op (never calls store.discard) when wireAccessCleanup is false', async () => {
    const store = createKimiLocalAccessStore();
    const discard = vi.spyOn(store, 'discard');
    const provider = createKimiRuntimeProviderFromEnv(
      { KIMI_API_KEY: 'test-key' },
      {
        ownershipSecret: OWNERSHIP_SECRET,
        artifactMcpUrl: ARTIFACT_MCP_URL,
        store,
        wireAccessCleanup: false,
      },
    )!;
    await provider.cleanupAccess!({
      resources: [
        { type: 'file', fileId: 'kimi-file-abc', mountPath: '/workspace/x' },
      ],
      credentialRefs: ['kimi-cred-abc'],
    });
    expect(discard).not.toHaveBeenCalled();
  });
});
