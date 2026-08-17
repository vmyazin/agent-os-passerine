import { describe, expect, it } from 'vitest';

import {
  createFailureFingerprint,
  createVerifierRegistry,
  detectStuck,
  registerVerifier,
  submitEvidence,
  verifyCriterion,
  type CommandCriterion,
} from './dod.js';

const criterion: CommandCriterion = {
  id: 'unit-tests',
  type: 'command',
  command: 'pnpm test',
  description: 'Tests pass',
};

describe('Definition of Done verification', () => {
  it('does not let an agent mark its own evidence passed', async () => {
    const evidence = submitEvidence({
      id: 'evidence-1',
      criterionId: criterion.id,
      submittedByAgentId: 'implementer',
      observedAt: new Date('2026-01-01T00:00:00Z'),
      payload: { claimedStatus: 'passed' },
    });

    expect(evidence.status).toBe('submitted');
    await expect(
      verifyCriterion(createVerifierRegistry(), criterion, evidence),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'verifier_not_registered',
    });
  });

  it('only accepts passed from a registered verifier', async () => {
    const registry = registerVerifier(createVerifierRegistry(), 'command', {
      id: 'trusted-command-verifier',
      verify: async () => ({ passed: true, message: 'exit 0' }),
    });
    const evidence = submitEvidence({
      id: 'evidence-1',
      criterionId: criterion.id,
      submittedByAgentId: 'implementer',
      observedAt: new Date('2026-01-01T00:00:00Z'),
      payload: { exitCode: 0 },
    });

    await expect(
      verifyCriterion(registry, criterion, evidence),
    ).resolves.toMatchObject({
      status: 'passed',
      verifierId: 'trusted-command-verifier',
    });
  });

  it('creates stable failure fingerprints and detects repeated stuck failures', () => {
    const fingerprint = createFailureFingerprint({
      criterionId: 'unit-tests',
      verifierId: 'command',
      code: 'exit_1',
      message: ' failed  ',
    });
    const same = createFailureFingerprint({
      message: 'failed',
      code: 'exit_1',
      verifierId: 'command',
      criterionId: 'unit-tests',
    });

    expect(same).toBe(fingerprint);
    expect(
      detectStuck([fingerprint, 'different', fingerprint, fingerprint], 3),
    ).toEqual({
      stuck: true,
      fingerprint,
      occurrences: 3,
    });
  });
});
