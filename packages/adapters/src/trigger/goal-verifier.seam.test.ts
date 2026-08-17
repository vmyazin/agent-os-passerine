import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  createHmacAttestationIssuer,
  createVerifierRegistry,
  registerVerifier,
  verifyCriterion,
  type CommandCriterion,
  type EvidenceSubmission,
  type JsonValue,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
import { createTrustedGoalCommandVerifier } from './goal-verifier.js';
import { exactTrustedCommand } from './production-handler.js';
import { createTrustedWorkflowVerifier } from './verifier.js';

const keys = [
  { keyId: 'seam-key', secret: 'trusted-goal-seam-secret-material-32!!' },
] as const;
const digest = 'a'.repeat(64);
const childRunId = 'goal-child-seam-1';

// The production seam under test: the feature workflow resolves the
// operator-facing allowlist key to a wrapped exact shell command, observes
// that wrapped command, and signs both into one report. The goal criterion
// must bind to the key, never to the wrapper.
async function trustedReportThroughRealVerifier() {
  const artifacts = createInMemoryArtifactStorage().store;
  const reportIssuer = createHmacAttestationIssuer({
    ...keys[0],
    kind: 'trusted-test-report',
  });
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
  const workflow = {
    version: 'feature-workflow-input-v1' as const,
    runId: childRunId,
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
  const result = await createTrustedWorkflowVerifier({
    artifacts,
    attest: (evidence) => {
      const evidenceDigest = createHash('sha256')
        .update(canonicalJsonValue(evidence))
        .digest('hex');
      return reportIssuer.issue({
        subject: `${childRunId}:verification:${evidenceDigest}`,
        issuedAt: '2026-08-17T11:59:59.000Z',
        claims: {
          source: 'managed-agent-command-observer',
          runId: childRunId,
          evidenceDigest,
        },
      }) as unknown as JsonValue;
    },
  }).verify({
    runId: childRunId,
    workflow,
    producingStepId: 'implementation',
    definitionOfDone: {
      version: 'definition-of-done-v1',
      criteria: [
        { id: 'tests', description: 'Tests pass', verifier: 'test-report' },
      ],
    },
    changeSet,
    testEvidence: {
      version: 'test-evidence-v1',
      passed: true,
      command: 'pnpm test',
      exitCode: 0,
    },
    review: { version: 'review-result-v1', decision: 'approved', findings: [] },
    trustedCommandObservation: {
      runId: childRunId,
      stepId: 'verification',
      command: exactTrustedCommand({
        executable: 'pnpm',
        arguments: ['test'],
      }),
      exitCode: 0,
      startedAt: '2026-08-17T12:00:00.000Z',
      completedAt: '2026-08-17T12:00:01.000Z',
      repositorySha: workflow.source.repositorySha,
      sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
      changeSetDigest: createHash('sha256')
        .update(canonicalJsonValue(changeSet))
        .digest('hex'),
      configDigest: workflow.digests.config,
    },
  });
  if (result.passed !== true || result.evidenceArtifact === undefined)
    throw new Error(
      `workflow verification failed: ${result.findings?.join('; ') ?? ''}`,
    );
  return { artifacts, artifact: result.evidenceArtifact };
}

function goalEvidence(
  artifact: Awaited<
    ReturnType<typeof trustedReportThroughRealVerifier>
  >['artifact'],
  criterionId: string,
): EvidenceSubmission {
  return {
    id: 'goal-evidence-seam-1',
    criterionId,
    submittedByAgentId: 'goal-workflow',
    observedAt: new Date('2026-08-17T12:00:02.000Z'),
    status: 'submitted',
    payload: {
      version: 'goal-command-evidence-v1',
      parentRunId: 'parent-goal-1',
      projectId: 'project-1',
      childRunId,
      artifact: artifact as unknown as JsonValue,
    },
  };
}

describe('goal verifier against reports built by the real workflow verifier', () => {
  it('passes a criterion naming the trusted command key', async () => {
    const { artifacts, artifact } = await trustedReportThroughRealVerifier();
    const criterion: CommandCriterion = {
      id: 'tests',
      type: 'command',
      description: 'The repository test suite passes',
      required: true,
      command: 'pnpm test',
    };
    const registry = registerVerifier(
      createVerifierRegistry(),
      'command',
      createTrustedGoalCommandVerifier({
        artifacts,
        keys,
        clock: () => '2026-08-17T12:00:03.000Z',
      }),
    );

    await expect(
      verifyCriterion(registry, criterion, goalEvidence(artifact, 'tests')),
    ).resolves.toMatchObject({ status: 'passed', criterionId: 'tests' });
  });

  it('rejects a criterion naming the wrapped shell string instead of the key', async () => {
    const { artifacts, artifact } = await trustedReportThroughRealVerifier();
    const criterion: CommandCriterion = {
      id: 'tests',
      type: 'command',
      description: 'The repository test suite passes',
      required: true,
      command: exactTrustedCommand({ executable: 'pnpm', arguments: ['test'] }),
    };
    const registry = registerVerifier(
      createVerifierRegistry(),
      'command',
      createTrustedGoalCommandVerifier({
        artifacts,
        keys,
        clock: () => '2026-08-17T12:00:03.000Z',
      }),
    );

    await expect(
      verifyCriterion(registry, criterion, goalEvidence(artifact, 'tests')),
    ).resolves.toMatchObject({
      status: 'failed',
      criterionId: 'tests',
      code: 'report_command_mismatch',
    });
  });
});
