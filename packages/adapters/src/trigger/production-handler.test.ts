import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createProductionFeatureWorkflowFromEnv } from './production-handler.js';

describe('production feature workflow composition', () => {
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
      }),
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
      'createTrustedGitHubPublisherService',
    ]) {
      expect(productionSource).toContain(factory);
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
