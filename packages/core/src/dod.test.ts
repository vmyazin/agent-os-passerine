import { describe, expect, it } from 'vitest';

import {
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
} from './attestation.js';
import {
  createFailureFingerprint,
  createVerifierRegistry,
  detectStuck,
  registerVerifier,
  submitEvidence,
  verifyCriterion,
  type CommandCriterion,
  type VerifierAttestation,
  type VerifierAttestationClaims,
} from './dod.js';

const criterion: CommandCriterion = {
  id: 'unit-tests',
  type: 'command',
  command: 'pnpm test',
  description: 'Tests pass',
};

const createSignedVerifierAuthority = () => {
  const key = { keyId: 'dod-test', secret: 'dod-test-secret' } as const;
  const issuer = createHmacAttestationIssuer<VerifierAttestationClaims>(key);
  return {
    issuer: {
      issue: (claims: VerifierAttestationClaims): VerifierAttestation =>
        JSON.parse(
          JSON.stringify(
            issuer.issue({
              kind: 'definition-of-done-verification',
              subject: `${claims.verifierId}:${claims.criterionId}:${claims.evidenceId}`,
              claims,
              issuedAt: '2026-08-16T20:00:00.000Z',
            }),
          ),
        ) as VerifierAttestation,
    },
    verifier: createHmacAttestationVerifier<VerifierAttestationClaims>({
      keys: [key],
    }),
  };
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
    const authority = createSignedVerifierAuthority();
    const registry = registerVerifier(createVerifierRegistry(), 'command', {
      id: 'trusted-command-verifier',
      attestationVerifier: authority.verifier,
      verify: async () =>
        authority.issuer.issue({
          source: 'registered-verifier',
          verifierId: 'trusted-command-verifier',
          criterionId: criterion.id,
          evidenceId: 'evidence-1',
          passed: true,
          message: 'exit 0',
        }),
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

  it('rejects verifier attestations not bound to the criterion and evidence', async () => {
    const authority = createSignedVerifierAuthority();
    const registry = registerVerifier(createVerifierRegistry(), 'command', {
      id: 'trusted-command-verifier',
      attestationVerifier: authority.verifier,
      verify: async () =>
        authority.issuer.issue({
          source: 'registered-verifier',
          verifierId: 'trusted-command-verifier',
          criterionId: 'different-criterion',
          evidenceId: 'different-evidence',
          passed: true,
          message: 'claimed pass',
        }),
    });
    const evidence = submitEvidence({
      id: 'evidence-1',
      criterionId: criterion.id,
      submittedByAgentId: 'implementer',
      observedAt: new Date('2026-01-01T00:00:00Z'),
      payload: { claimedStatus: 'passed' },
    });

    await expect(
      verifyCriterion(registry, criterion, evidence),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'attestation_mismatch',
    });
  });

  it('rejects a structural verifier claim not issued by its authority', async () => {
    const authority = createSignedVerifierAuthority();
    const registry = registerVerifier(createVerifierRegistry(), 'command', {
      id: 'trusted-command-verifier',
      attestationVerifier: authority.verifier,
      verify: async () =>
        ({
          source: 'registered-verifier',
          verifierId: 'trusted-command-verifier',
          criterionId: criterion.id,
          evidenceId: 'evidence-1',
          passed: true,
          message: 'structural lookalike',
        }) as unknown as VerifierAttestation,
    });
    const evidence = submitEvidence({
      id: 'evidence-1',
      criterionId: criterion.id,
      submittedByAgentId: 'implementer',
      observedAt: new Date('2026-01-01T00:00:00Z'),
      payload: {},
    });

    await expect(
      verifyCriterion(registry, criterion, evidence),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'attestation_mismatch',
    });
  });

  it('binds persisted verifier attestations to verifier, criterion, and evidence', async () => {
    const key = { keyId: 'dod', secret: 'dod-secret' } as const;
    const issuer = createHmacAttestationIssuer<VerifierAttestationClaims>(key);
    const registry = registerVerifier(createVerifierRegistry(), 'command', {
      id: 'trusted-command-verifier',
      attestationVerifier:
        createHmacAttestationVerifier<VerifierAttestationClaims>({
          keys: [key],
        }),
      verify: async () =>
        JSON.parse(
          JSON.stringify(
            issuer.issue({
              kind: 'definition-of-done-verification',
              subject: 'trusted-command-verifier:unit-tests:other-evidence',
              claims: {
                source: 'registered-verifier',
                verifierId: 'trusted-command-verifier',
                criterionId: criterion.id,
                evidenceId: 'evidence-1',
                passed: true,
                message: 'exit 0',
              },
              issuedAt: '2026-08-16T20:00:00.000Z',
            }),
          ),
        ) as VerifierAttestation,
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
      status: 'failed',
      code: 'attestation_mismatch',
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
