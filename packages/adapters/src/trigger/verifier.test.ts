import { describe, expect, it } from 'vitest';

import { createTrustedWorkflowVerifier } from './verifier.js';

const digest = 'a'.repeat(64);
const workflow = {
  version: 'feature-workflow-input-v1' as const,
  runId: 'run-1',
  projectId: 'project-1',
  feature: { title: 'Status', description: 'Add it' },
  source: { repositorySha: 'b'.repeat(40), sourceSnapshotDigest: digest },
  digests: {
    config: digest,
    model: digest,
    prompt: digest,
    environment: digest,
    policy: digest,
  },
};
const executor = {
  execute: async (input: {
    workflow: typeof workflow;
    stepId: string;
    command: string;
    changeSetDigest: string;
  }) => ({
    runId: input.workflow.runId,
    stepId: input.stepId,
    command: input.command,
    exitCode: 0,
    startedAt: '2026-08-17T12:00:00.000Z',
    completedAt: '2026-08-17T12:00:01.000Z',
    repositorySha: input.workflow.source.repositorySha,
    sourceSnapshotDigest: input.workflow.source.sourceSnapshotDigest,
    changeSetDigest: input.changeSetDigest,
    configDigest: input.workflow.digests.config,
  }),
};

const base = {
  runId: 'run-1',
  workflow,
  producingStepId: 'implementation',
  definitionOfDone: {
    version: 'definition-of-done-v1',
    criteria: [
      { id: 'tests', description: 'Tests pass', verifier: 'test-report' },
    ],
  },
  testEvidence: {
    version: 'test-evidence-v1',
    passed: true,
    command: 'pnpm test',
    exitCode: 0,
  },
  review: { version: 'review-result-v1', decision: 'approved', findings: [] },
};

describe('trusted workflow verifier', () => {
  it('produces deterministic evidence for a bounded allowed change set', async () => {
    const verifier = createTrustedWorkflowVerifier({ executor });
    const input = {
      ...base,
      changeSet: {
        version: 'change-set-v1',
        changes: [
          {
            operation: 'add',
            path: 'src/status.ts',
            mode: '100644',
            content: 'export {};\n',
          },
        ],
      },
    };
    const first = await verifier.verify(input);
    const second = await verifier.verify(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      passed: true,
      evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('fails protected paths before publication', async () => {
    const result = await createTrustedWorkflowVerifier({ executor }).verify({
      ...base,
      changeSet: {
        version: 'change-set-v1',
        changes: [
          {
            operation: 'add',
            path: '.github/workflows/pwn.yml',
            mode: '100644',
            content: 'name: pwn\n',
          },
        ],
      },
    });
    expect(result).toMatchObject({ passed: false });
    expect(result.findings?.join(' ')).toMatch(/denied path/i);
  });
});
