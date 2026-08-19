import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createProductionFeatureWorkflowFromEnv,
  exactTrustedCommand,
  kimiFromEnv,
} from './production-handler.js';

function completeEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const secret = 's'.repeat(32);
  return {
    DATABASE_URL: 'postgresql://agentos:agentos@localhost:5432/agentos',
    CLOUDFLARE_R2_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_R2_ARTIFACT_BUCKET: 'artifacts',
    CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID: 'access',
    CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY: 'secret',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    AGENTOS_RUNTIME_OWNERSHIP_SECRET: secret,
    AGENTOS_RUNTIME_HANDLE_KEY: Buffer.alloc(32, 7).toString('base64url'),
    AGENTOS_ARTIFACT_MCP_URL: 'https://artifacts.example.test/mcp',
    ARTIFACT_CAPABILITY_KEYS_JSON: JSON.stringify([
      { keyId: 'artifact-1', secret },
    ]),
    GITHUB_PUBLICATION_KEYS_JSON: JSON.stringify([
      { keyId: 'publisher-1', secret },
    ]),
    AGENTOS_TEST_REPORT_KEYS_JSON: JSON.stringify([
      { keyId: 'test-report-1', secret },
    ]),
    GITHUB_SELECTED_REPOSITORIES_JSON: JSON.stringify([
      {
        owner: 'team-zork',
        name: 'sandbox',
        installationId: 1,
        repositoryId: 2,
      },
    ]),
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'placeholder-overridden-below',
    AGENTOS_TRUSTED_TEST_COMMANDS_JSON: JSON.stringify({
      'pnpm test': { executable: 'pnpm', arguments: ['test'] },
    }),
    AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON: JSON.stringify([
      'registry.npmjs.org',
    ]),
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

describe('production feature workflow composition', () => {
  it('builds one observed secretless install-and-test command', () => {
    const command = exactTrustedCommand({
      executable: 'pnpm',
      arguments: ['test'],
    });
    expect(command).toContain(
      'pnpm install --frozen-lockfile --ignore-scripts',
    );
    expect(command.indexOf('pnpm install')).toBeLessThan(
      command.indexOf("'pnpm' 'test'"),
    );
    expect(command).toContain('AGENTOS_EXIT_CODE');
  });

  it('fails closed with an actionable, secret-free missing environment error', async () => {
    const error = await createProductionFeatureWorkflowFromEnv({}).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/DATABASE_URL|required/i);
    expect(String(error)).not.toMatch(/api[_-]?key|private[_-]?key.*=/i);
  });

  it('resolves the concrete production handler from complete server-only configuration without live calls', async () => {
    const secret = 's'.repeat(32);
    const privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    await expect(
      createProductionFeatureWorkflowFromEnv({
        DATABASE_URL: 'postgresql://agentos:agentos@localhost:5432/agentos',
        CLOUDFLARE_R2_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_R2_ARTIFACT_BUCKET: 'artifacts',
        CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID: 'access',
        CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY: 'secret',
        ANTHROPIC_API_KEY: 'test-anthropic-key',
        AGENTOS_RUNTIME_OWNERSHIP_SECRET: secret,
        AGENTOS_RUNTIME_HANDLE_KEY: Buffer.alloc(32, 7).toString('base64url'),
        AGENTOS_ARTIFACT_MCP_URL: 'https://artifacts.example.test/mcp',
        ARTIFACT_CAPABILITY_KEYS_JSON: JSON.stringify([
          { keyId: 'artifact-1', secret },
        ]),
        GITHUB_PUBLICATION_KEYS_JSON: JSON.stringify([
          { keyId: 'publisher-1', secret },
        ]),
        AGENTOS_TEST_REPORT_KEYS_JSON: JSON.stringify([
          { keyId: 'test-report-1', secret },
        ]),
        GITHUB_SELECTED_REPOSITORIES_JSON: JSON.stringify([
          {
            owner: 'team-zork',
            name: 'sandbox',
            installationId: 1,
            repositoryId: 2,
          },
        ]),
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: privateKey,
        AGENTOS_TRUSTED_TEST_COMMANDS_JSON: JSON.stringify({
          'pnpm test': { executable: 'pnpm', arguments: ['test'] },
        }),
        AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON: JSON.stringify([
          'registry.npmjs.org',
        ]),
      }),
    ).resolves.toMatchObject({ run: expect.any(Function) });
  });

  it('kimiFromEnv treats blank and whitespace-only KIMI_API_KEY as absent', () => {
    expect(kimiFromEnv({})).toBeUndefined();
    expect(kimiFromEnv({ KIMI_API_KEY: '' })).toBeUndefined();
    expect(kimiFromEnv({ KIMI_API_KEY: '  ' })).toBeUndefined();
    expect(kimiFromEnv({ KIMI_API_KEY: 'k', KIMI_BASE_URL: '' })).toEqual({
      apiKey: 'k',
    });
  });

  it('resolves the concrete production handler unchanged when KIMI_API_KEY is blank (regression: no-kimi construction is untouched)', async () => {
    const privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    await expect(
      createProductionFeatureWorkflowFromEnv(
        completeEnv({ GITHUB_APP_PRIVATE_KEY: privateKey, KIMI_API_KEY: '' }),
      ),
    ).resolves.toMatchObject({ run: expect.any(Function) });
  });

  it('resolves the concrete production handler when KIMI_API_KEY is present (kimi runtime builds without live calls)', async () => {
    const privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    await expect(
      createProductionFeatureWorkflowFromEnv(
        completeEnv({
          GITHUB_APP_PRIVATE_KEY: privateKey,
          KIMI_API_KEY: 'kimi-test-key',
        }),
      ),
    ).resolves.toMatchObject({ run: expect.any(Function) });
  });

  it('keeps the deployable task bound to the in-repo concrete composition', async () => {
    const taskSource = await readFile(
      resolve(process.cwd(), 'src/trigger/task.ts'),
      'utf8',
    );
    const compositionSource = await readFile(
      resolve(process.cwd(), 'src/trigger/production-composition.ts'),
      'utf8',
    );
    const productionSource = await readFile(
      resolve(process.cwd(), 'src/trigger/production-handler.ts'),
      'utf8',
    );
    expect(taskSource).toContain(
      'createLazyProductionFeatureWorkflowTaskHandler',
    );
    expect(compositionSource).toContain("import('./production-handler.js')");
    for (const factory of [
      'createNeonDomainRepositoryFromEnv',
      'createNeonWorkflowCheckpointStore',
      'createR2ArtifactStore',
      'createManagedAgentsRuntimeProvider',
      'createTrustedWorkflowVerifier',
      'composePublicationTarget',
    ]) {
      expect(productionSource).toContain(factory);
    }
    // The GitHub- and local-git-backed publisher constructions live in
    // composePublicationTarget (production-composition.ts) so a local-only
    // deployment's per-snapshot selection never needs GitHub env at
    // module-init time; verify both concrete factories are still wired
    // there rather than swapped for a fake.
    for (const factory of [
      'createTrustedGitHubPublisherService',
      'createLocalGitPublisher',
    ]) {
      expect(compositionSource).toContain(factory);
    }
    expect(productionSource).not.toContain(
      'AGENTOS_PRODUCTION_COMPOSITION_MODULE',
    );
    expect(productionSource).not.toContain('randomUUID');
    expect(productionSource).not.toContain('node:child_process');
    expect(productionSource).not.toContain('createNodeTrustedCommandExecutor');
    expect(productionSource).toContain('nonce: `publish-${workflow.runId}`');
  });
});
