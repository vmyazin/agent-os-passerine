import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createNodeTrustedCommandExecutor } from './trusted-command-executor.js';

describe('trusted command executor', () => {
  it('executes only the server allowlisted argv without a shell and binds its observation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentos-trusted-test-'));
    let cleaned = false;
    const executor = createNodeTrustedCommandExecutor({
      materializer: {
        prepare: async () => ({
          cwd: workspace,
          cleanup: async () => {
            cleaned = true;
            await rm(workspace, { recursive: true });
          },
        }),
      },
      allowedCommands: {
        'trusted-test': {
          executable: process.execPath,
          arguments: ['-e', 'process.exit(0)'],
        },
      },
      clock: () => '2026-08-17T12:00:00.000Z',
    });
    await expect(
      executor.execute({
        workflow: {
          version: 'feature-workflow-input-v1',
          runId: 'run-1',
          projectId: 'project-1',
          feature: { title: 'Feature', description: 'Description' },
          source: {
            repositorySha: 'a'.repeat(40),
            sourceSnapshotDigest: 'b'.repeat(64),
          },
          digests: {
            config: 'c'.repeat(64),
            model: 'd'.repeat(64),
            prompt: 'e'.repeat(64),
            environment: 'f'.repeat(64),
            policy: '0'.repeat(64),
          },
        },
        stepId: 'implementation',
        command: 'trusted-test',
        changeSet: { version: 'change-set-v1', changes: [] },
        changeSetDigest: '1'.repeat(64),
      }),
    ).resolves.toMatchObject({
      runId: 'run-1',
      stepId: 'implementation',
      command: 'trusted-test',
      exitCode: 0,
      repositorySha: 'a'.repeat(40),
      sourceSnapshotDigest: 'b'.repeat(64),
      changeSetDigest: '1'.repeat(64),
      configDigest: 'c'.repeat(64),
    });
    expect(cleaned).toBe(true);
  });

  it('rejects agent-selected commands that are not in the trusted allowlist', async () => {
    const executor = createNodeTrustedCommandExecutor({
      materializer: {
        prepare: async () => {
          throw new Error('must not materialize');
        },
      },
      allowedCommands: {},
      clock: () => '2026-08-17T12:00:00.000Z',
    });
    await expect(
      executor.execute({
        workflow: {} as never,
        stepId: 'implementation',
        command: 'rm -rf /',
        changeSet: {},
        changeSetDigest: '1'.repeat(64),
      }),
    ).rejects.toThrow('allowlist');
  });
});
