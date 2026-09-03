import { describe, expect, it } from 'vitest';

import {
  createLocalDirectFeatureWorkflowFromEnv,
  LocalDirectCompositionError,
  missingLocalDirectVariables,
} from './composition.js';

/**
 * A configuration that satisfies every check this module makes. No value here
 * reaches a network: composition builds stores and providers, it does not
 * connect. The Neon driver is lazy, so DATABASE_URL only has to parse.
 */
function completeEnvironment(): Record<string, string> {
  return {
    AGENTOS_LOCAL_STATE_DIR: '/tmp/agentos-local-direct-test',
    AGENTOS_LOCAL_WORKSPACES_ROOT: '/tmp/agentos-workspaces',
    AGENTOS_RUNTIME_OWNERSHIP_SECRET: 'o'.repeat(32),
    AGENTOS_RUNTIME_HANDLE_KEY: Buffer.alloc(32, 7).toString('base64url'),
    AGENTOS_TRUSTED_TEST_COMMANDS_JSON: JSON.stringify({
      'pnpm test': { executable: 'pnpm', arguments: ['test'] },
    }),
    AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON: JSON.stringify([
      'registry.npmjs.org',
    ]),
    AGENTOS_TEST_REPORT_KEYS_JSON: JSON.stringify([
      { keyId: 'test-report-1', secret: 's'.repeat(32) },
    ]),
    ARTIFACT_CAPABILITY_KEYS_JSON: JSON.stringify([
      { keyId: 'capability-1', secret: 'c'.repeat(32) },
    ]),
    GITHUB_PUBLICATION_KEYS_JSON: JSON.stringify([
      { keyId: 'publication-1', secret: 'p'.repeat(32) },
    ]),
    DATABASE_URL: 'postgresql://user:pass@example.neon.tech/db',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  };
}

describe('missingLocalDirectVariables', () => {
  it('reports nothing for a complete environment', () => {
    expect(missingLocalDirectVariables(completeEnvironment())).toEqual([]);
  });

  it('names every missing variable at once rather than the first', () => {
    const missing = missingLocalDirectVariables({
      AGENTOS_LOCAL_STATE_DIR: '/tmp/state',
    });
    expect(missing).toContain('DATABASE_URL');
    expect(missing).toContain('ARTIFACT_CAPABILITY_KEYS_JSON');
    expect(missing).not.toContain('AGENTOS_LOCAL_STATE_DIR');
    expect(missing.length).toBeGreaterThan(4);
  });

  it('accepts either model key but requires one of them', () => {
    const withoutKeys = completeEnvironment();
    delete (withoutKeys as Record<string, string | undefined>)
      .ANTHROPIC_API_KEY;
    expect(missingLocalDirectVariables(withoutKeys)).toContain(
      'ANTHROPIC_API_KEY or KIMI_API_KEY',
    );
    expect(
      missingLocalDirectVariables({ ...withoutKeys, KIMI_API_KEY: 'sk-kimi' }),
    ).toEqual([]);
  });

  it('treats a blank value as absent', () => {
    expect(
      missingLocalDirectVariables({
        ...completeEnvironment(),
        DATABASE_URL: '  ',
      }),
    ).toContain('DATABASE_URL');
  });
});

describe('createLocalDirectFeatureWorkflowFromEnv', () => {
  it('composes a handler from a complete environment', async () => {
    const handler = await createLocalDirectFeatureWorkflowFromEnv(
      completeEnvironment(),
    );
    expect(typeof handler.run).toBe('function');
  });

  it('refuses an incomplete environment and names what is missing', async () => {
    const incomplete = completeEnvironment();
    delete (incomplete as Record<string, string | undefined>)
      .AGENTOS_TEST_REPORT_KEYS_JSON;
    await expect(
      createLocalDirectFeatureWorkflowFromEnv(incomplete),
    ).rejects.toThrow(/AGENTOS_TEST_REPORT_KEYS_JSON/);
    await expect(
      createLocalDirectFeatureWorkflowFromEnv(incomplete),
    ).rejects.toBeInstanceOf(LocalDirectCompositionError);
  });

  it('requires an absolute state directory', async () => {
    await expect(
      createLocalDirectFeatureWorkflowFromEnv({
        ...completeEnvironment(),
        AGENTOS_LOCAL_STATE_DIR: 'relative/state',
      }),
    ).rejects.toThrow(/must be an absolute path/);
  });

  it('needs no R2, Trigger, Managed Agents, or artifact MCP URL variables', async () => {
    const environment = completeEnvironment();
    for (const name of [
      'CLOUDFLARE_R2_ACCOUNT_ID',
      'CLOUDFLARE_R2_ARTIFACT_BUCKET',
      'TRIGGER_SECRET_KEY',
      'AGENTOS_ARTIFACT_MCP_URL',
      'GITHUB_APP_ID',
    ])
      expect(environment[name]).toBeUndefined();
    await expect(
      createLocalDirectFeatureWorkflowFromEnv(environment),
    ).resolves.toBeDefined();
  });

  it('rejects malformed capability keys with a named error', async () => {
    await expect(
      createLocalDirectFeatureWorkflowFromEnv({
        ...completeEnvironment(),
        ARTIFACT_CAPABILITY_KEYS_JSON: 'not json',
      }),
    ).rejects.toThrow(/must contain valid JSON/);
  });
});
