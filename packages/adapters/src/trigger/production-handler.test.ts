import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createProductionFeatureWorkflowFromEnv } from './production-handler.js';
import { createSourceBundleMaterializer } from './production-handler.js';

describe('production feature workflow composition', () => {
  it('materializes a bounded source bundle and rejects traversal before trusted tests', async () => {
    const materializer = createSourceBundleMaterializer({
      version: 'source-bundle-v1',
      files: [{ path: 'src/index.ts', mode: '100644', content: 'old\n' }],
    });
    const workspace = await materializer.prepare({
      changeSet: {
        version: 'change-set-v1',
        changes: [
          {
            operation: 'modify',
            path: 'src/index.ts',
            mode: '100644',
            content: 'new\n',
          },
        ],
      },
    });
    await expect(
      readFile(resolve(workspace.cwd, 'src/index.ts'), 'utf8'),
    ).resolves.toBe('new\n');
    await workspace.cleanup();
    await expect(
      materializer.prepare({
        changeSet: {
          version: 'change-set-v1',
          changes: [
            {
              operation: 'add',
              path: '../escape',
              mode: '100644',
              content: 'no',
            },
          ],
        },
      }),
    ).rejects.toThrow(/escape|unsafe/);
  });

  it('fails closed with an actionable, secret-free missing environment error', async () => {
    const error = await createProductionFeatureWorkflowFromEnv({}).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/DATABASE_URL|required/i);
    expect(String(error)).not.toMatch(/api[_-]?key|private[_-]?key.*=/i);
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
      'createNodeTrustedCommandExecutor',
      'createTrustedWorkflowVerifier',
      'createTrustedGitHubPublisherService',
    ]) {
      expect(productionSource).toContain(factory);
    }
    expect(productionSource).not.toContain(
      'AGENTOS_PRODUCTION_COMPOSITION_MODULE',
    );
    expect(productionSource).not.toContain('randomUUID');
    expect(productionSource).toContain('nonce: `publish-${workflow.runId}`');
  });
});
