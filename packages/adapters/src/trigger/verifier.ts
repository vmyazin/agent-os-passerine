import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  DEFAULT_PUBLICATION_POLICY,
  evaluatePublicationPolicy,
  type JsonValue,
} from '@agentos/core';

import {
  changeSetSchema,
  definitionOfDoneSchema,
  reviewArtifactSchema,
  testEvidenceSchema,
} from './schemas.js';
import type { WorkflowVerifier } from './types.js';

export function createTrustedWorkflowVerifier(
  policy: unknown = DEFAULT_PUBLICATION_POLICY,
): WorkflowVerifier {
  const verifier: WorkflowVerifier = {
    async verify(input) {
      try {
        const definitionOfDone = definitionOfDoneSchema.parse(
          input.definitionOfDone,
        );
        const changeSet = changeSetSchema.parse(input.changeSet);
        const testEvidence = testEvidenceSchema.parse(input.testEvidence);
        const review = reviewArtifactSchema.parse(input.review);
        evaluatePublicationPolicy(changeSet.changes, policy);
        const evidence: JsonValue = {
          version: 'workflow-verification-v1',
          runId: input.runId,
          definitionOfDone,
          changeSet,
          testEvidence,
          review,
        };
        return {
          passed: true,
          evidenceDigest: createHash('sha256')
            .update(canonicalJsonValue(evidence))
            .digest('hex'),
        };
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
