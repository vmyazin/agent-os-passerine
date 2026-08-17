import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  createHmacAttestationIssuer,
  createVerifierRegistry,
  registerVerifier,
  verifyCriterion,
  type CommandCriterion,
  type EvidenceSubmission,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
import { createTrustedGoalCommandVerifier } from './goal-verifier.js';

const keys = [
  {
    keyId: 'test-report-key',
    secret: 'trusted-goal-report-secret-material-32!',
  },
] as const;
const reportIssuer = createHmacAttestationIssuer({
  ...keys[0],
  kind: 'trusted-test-report',
});
const dodIssuer = createHmacAttestationIssuer({
  ...keys[0],
  kind: 'definition-of-done-verification',
});
const criterion: CommandCriterion = {
  id: 'tests',
  type: 'command',
  description: 'Tests pass',
  required: true,
  command: 'pnpm test',
};

interface FixtureMutation {
  readonly forged?: boolean;
  readonly malformed?: boolean;
  readonly reportAttestationKind?: 'trusted-test-report' | 'dod';
  readonly subject?: string;
  readonly claimsDigest?: string;
  readonly claimsRunId?: string;
  readonly evidenceRunId?: string;
  readonly payloadChildRunId?: string;
  readonly observation?: Readonly<
    Partial<{
      runId: string;
      command: string;
      exitCode: number;
      startedAt: string;
      completedAt: string;
    }>
  >;
}

async function fixture(mutation: FixtureMutation = {}) {
  const artifacts = createInMemoryArtifactStorage().store;
  const childRunId = 'child-run-1';
  const observation = {
    runId: childRunId,
    stepId: 'verification',
    command: criterion.command,
    exitCode: 0,
    startedAt: '2026-08-17T12:00:00.000Z',
    completedAt: '2026-08-17T12:00:01.000Z',
    repositorySha: 'a'.repeat(40),
    sourceSnapshotDigest: 'b'.repeat(64),
    changeSetDigest: 'c'.repeat(64),
    configDigest: 'd'.repeat(64),
    ...mutation.observation,
  };
  const reportEvidence = {
    version: 'workflow-verification-v3',
    runId: mutation.evidenceRunId ?? childRunId,
    trustedCommandObservation: observation,
  };
  const evidenceDigest = createHash('sha256')
    .update(canonicalJsonValue(reportEvidence))
    .digest('hex');
  const issuer =
    mutation.reportAttestationKind === 'dod' ? dodIssuer : reportIssuer;
  let attestation = issuer.issue({
    subject: mutation.subject ?? `${childRunId}:verification:${evidenceDigest}`,
    issuedAt: '2026-08-17T11:59:59.000Z',
    claims: {
      source: 'managed-agent-command-observer',
      runId: mutation.claimsRunId ?? childRunId,
      evidenceDigest: mutation.claimsDigest ?? evidenceDigest,
    },
  });
  if (mutation.forged)
    attestation = { ...attestation, signature: 'forged-signature' };
  const report = mutation.malformed
    ? { malformed: true }
    : {
        version: 'trusted-test-report-v1',
        evidence: reportEvidence,
        attestation,
      };
  const artifact = await artifacts.put({
    scope: {
      projectId: 'project-1',
      runId: childRunId,
      stepId: 'verification',
    },
    artifactId: 'trusted-test-report',
    version: 1,
    bytes: new TextEncoder().encode(canonicalJsonValue(report)),
    mediaType: 'application/json',
    retentionClass: 'working',
  });
  const evidence: EvidenceSubmission = {
    id: 'goal-evidence-1',
    criterionId: criterion.id,
    submittedByAgentId: 'goal-workflow',
    observedAt: new Date('2026-08-17T12:00:02.000Z'),
    status: 'submitted',
    payload: {
      version: 'goal-command-evidence-v1',
      parentRunId: 'parent-goal-1',
      projectId: 'project-1',
      childRunId: mutation.payloadChildRunId ?? childRunId,
      artifact,
    },
  };
  const verifier = createTrustedGoalCommandVerifier({
    artifacts,
    keys,
    clock: () => '2026-08-17T12:00:03.000Z',
  });
  const registry = registerVerifier(
    createVerifierRegistry(),
    'command',
    verifier,
  );
  return { evidence, registry };
}

describe('trusted goal command verifier', () => {
  it('accepts a signed child trusted-test report and issues a domain-separated DoD attestation', async () => {
    const { evidence, registry } = await fixture();

    await expect(
      verifyCriterion(registry, criterion, evidence),
    ).resolves.toMatchObject({
      status: 'passed',
      criterionId: criterion.id,
      verifierId: 'trusted-goal-command',
      attestation: { kind: 'definition-of-done-verification' },
    });
  });

  it.each([
    ['forged signature', { forged: true }],
    ['wrong child run', { observation: { runId: 'other-child' } }],
    ['wrong report subject', { subject: 'wrong-subject' }],
    ['wrong evidence digest', { claimsDigest: '0'.repeat(64) }],
    ['wrong claims run', { claimsRunId: 'other-child' }],
    ['wrong command', { observation: { command: 'pnpm lint' } }],
    ['nonzero exit', { observation: { exitCode: 1 } }],
    [
      'reversed timestamps',
      {
        observation: {
          startedAt: '2026-08-17T12:00:02.000Z',
          completedAt: '2026-08-17T12:00:01.000Z',
        },
      },
    ],
    ['malformed report', { malformed: true }],
    ['mismatched payload child', { payloadChildRunId: 'other-child' }],
    ['DoD token replayed as a report', { reportAttestationKind: 'dod' }],
  ] as const)('rejects %s', async (_name, mutation) => {
    const { evidence, registry } = await fixture(mutation);

    await expect(
      verifyCriterion(registry, criterion, evidence),
    ).resolves.toMatchObject({ status: 'failed', criterionId: criterion.id });
  });
});
