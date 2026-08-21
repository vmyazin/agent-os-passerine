import { createHash } from 'node:crypto';

import { canonicalJsonValue } from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
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
const observation = (changeSet: unknown) => ({
  runId: workflow.runId,
  stepId: 'verification',
  command:
    "set +e; 'pnpm' 'test'; code=$?; printf 'AGENTOS_EXIT_CODE=%s' \"$code\"; exit \"$code\"",
  exitCode: 0,
  startedAt: '2026-08-17T12:00:00.000Z',
  completedAt: '2026-08-17T12:00:01.000Z',
  repositorySha: workflow.source.repositorySha,
  sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
  changeSetDigest: createHash('sha256')
    .update(canonicalJsonValue(changeSet))
    .digest('hex'),
  configDigest: workflow.digests.config,
});

const verifier = () =>
  createTrustedWorkflowVerifier({
    artifacts: createInMemoryArtifactStorage().store,
    attest: (evidence) => ({ kind: 'test-attestation', evidence }),
  });

const base = {
  runId: 'run-1',
  workflow,
  producingStepId: 'implementation',
  definitionOfDone: {
    version: 'definition-of-done-v2',
    criteria: [
      { id: 'tests', description: 'Tests pass', verifier: 'test-report' },
    ],
    acceptanceTests: [
      {
        path: 'test/acceptance/tests.test.mjs',
        mode: '100644',
        content: "import { test } from 'node:test';\n",
      },
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
    const changeSet = {
      version: 'change-set-v1' as const,
      changes: [
        {
          operation: 'add' as const,
          path: 'src/status.ts',
          mode: '100644' as const,
          content: 'export {};\n',
        },
      ],
    };
    const input = {
      ...base,
      changeSet,
      trustedCommandObservation: observation(changeSet),
    };
    const subject = verifier();
    const first = await subject.verify(input);
    const second = await subject.verify(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      passed: true,
      evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('fails protected paths before publication', async () => {
    const changeSet = {
      version: 'change-set-v1' as const,
      changes: [
        {
          operation: 'add' as const,
          path: '.github/workflows/pwn.yml',
          mode: '100644' as const,
          content: 'name: pwn\n',
        },
      ],
    };
    const result = await verifier().verify({
      ...base,
      changeSet,
      trustedCommandObservation: observation(changeSet),
    });
    expect(result).toMatchObject({ passed: false });
    expect(result.findings?.join(' ')).toMatch(/denied path/i);
  });
});
