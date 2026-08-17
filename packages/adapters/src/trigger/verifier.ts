import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  DEFAULT_PUBLICATION_POLICY,
  evaluatePublicationPolicy,
  type JsonValue,
} from '@agentos/core';
import { z } from 'zod';

import {
  changeSetSchema,
  definitionOfDoneSchema,
  reviewArtifactSchema,
  testEvidenceSchema,
} from './schemas.js';
import type { TrustedCommandExecutor, WorkflowVerifier } from './types.js';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const observationSchema = z
  .object({
    runId: z.string().min(1).max(128),
    stepId: z.string().min(1).max(128),
    command: z.string().min(1).max(2_000),
    exitCode: z.number().int(),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
    repositorySha: z.string().regex(/^[0-9a-f]{40}$/),
    sourceSnapshotDigest: digest,
    changeSetDigest: digest,
    configDigest: digest,
  })
  .strict();

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonValue(value)).digest('hex');
}

export function createTrustedWorkflowVerifier(options: {
  readonly executor: TrustedCommandExecutor;
  readonly policy?: unknown;
}): WorkflowVerifier {
  const verifier: WorkflowVerifier = {
    async verify(input) {
      try {
        const definitionOfDone = definitionOfDoneSchema.parse(
          input.definitionOfDone,
        );
        const changeSet = changeSetSchema.parse(input.changeSet);
        const testEvidence = testEvidenceSchema.parse(input.testEvidence);
        const review = reviewArtifactSchema.parse(input.review);
        evaluatePublicationPolicy(
          changeSet.changes,
          options.policy ?? DEFAULT_PUBLICATION_POLICY,
        );
        if (review.decision !== 'approved')
          throw new Error('final trusted review is not approved');
        const changeSetDigest = hash(changeSet);
        const observed = observationSchema.parse(
          await options.executor.execute({
            workflow: input.workflow,
            stepId: input.producingStepId,
            command: testEvidence.command,
            changeSet: changeSet as JsonValue,
            changeSetDigest,
          }),
        );
        const expected = {
          runId: input.runId,
          stepId: input.producingStepId,
          command: testEvidence.command,
          repositorySha: input.workflow.source.repositorySha,
          sourceSnapshotDigest: input.workflow.source.sourceSnapshotDigest,
          changeSetDigest,
          configDigest: input.workflow.digests.config,
        };
        for (const [key, value] of Object.entries(expected)) {
          if (observed[key as keyof typeof observed] !== value)
            throw new Error(`trusted command observation ${key} mismatch`);
        }
        if (
          observed.exitCode !== 0 ||
          Date.parse(observed.completedAt) < Date.parse(observed.startedAt)
        ) {
          throw new Error('trusted test command failed');
        }
        const evidence: JsonValue = {
          version: 'workflow-verification-v2',
          runId: input.runId,
          definitionOfDone,
          changeSet,
          trustedCommandObservation: observed,
          review,
        };
        return { passed: true, evidenceDigest: hash(evidence) };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message.slice(0, 500)
            : 'verification failed';
        return {
          passed: false,
          evidenceDigest: createHash('sha256')
            .update(`failed:${message}`)
            .digest('hex'),
          findings: [message],
        };
      }
    },
  };
  return Object.freeze(verifier);
}
