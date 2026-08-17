import { describe, expect, it } from 'vitest';

import { createTrustedWorkflowVerifier } from './verifier.js';

const base = {
  runId: 'run-1',
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
    const verifier = createTrustedWorkflowVerifier();
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
    const result = await createTrustedWorkflowVerifier().verify({
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
