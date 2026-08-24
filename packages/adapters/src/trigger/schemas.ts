import {
  PUBLICATION_MAX_FILE_BYTES,
  PUBLICATION_MAX_FILES,
  PUBLICATION_MAX_TOTAL_BYTES,
  acceptanceTestImportSafetyError,
  acceptanceTestsPairingError,
  isAcceptanceTestPath,
} from '@agentos/core';
import { z } from 'zod';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/**
 * Why an artifact failed its schema, in terms an operator can act on.
 *
 * "artifact did not match its required schema" is true of every artifact in
 * the workflow: it names neither which one nor what about it. The usual
 * cause is a configuration whose agent prompts predate a schema version, and
 * that is only diagnosable if the message says which artifact and which
 * fields.
 *
 * Paths only. An issue's `received` value would echo agent-authored content
 * into a durable error message stored on the run.
 */
export function artifactSchemaFailureMessage(
  expected: { readonly stepId: string; readonly artifactId: string },
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): string {
  const fields = [
    ...new Set(
      issues
        .map((issue) => issue.path.map((part) => String(part)).join('.'))
        .filter((path) => path !== ''),
    ),
  ].slice(0, 5);
  return (
    `the ${expected.stepId} step's "${expected.artifactId}" artifact did not match its required schema` +
    (fields.length === 0 ? '' : ` (${fields.join(', ')})`)
  );
}

/** Where a chained run reads its source, resolved by the control plane. */
export const runChainSchema = z
  .object({
    baseRunId: identifier,
    baseBranch: z.string().min(1).max(512),
    baseCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export const featureWorkflowInputSchema = z
  .object({
    version: z.literal('feature-workflow-input-v1'),
    /**
     * Set when this run builds on an earlier run's publication. It redirects
     * two things and nothing else: the SHA source ingestion resolves, and
     * the base the publication manifest expects. Provenance below still
     * pins the applied configuration revision.
     */
    chain: runChainSchema.optional(),
    runId: identifier,
    projectId: identifier,
    feature: z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(20_000),
      })
      .strict(),
    source: z
      .object({
        repositorySha: z.string().regex(/^[0-9a-f]{40}$/),
        sourceSnapshotDigest: digest,
        sourceArtifactKey: z.string().min(1).max(2048).optional(),
      })
      .strict(),
    digests: z
      .object({
        config: digest,
        model: digest,
        prompt: digest,
        environment: digest,
        policy: digest,
      })
      .strict(),
  })
  .strict();

export const artifactReferenceSchema = z
  .object({
    projectId: identifier,
    runId: identifier,
    stepId: identifier,
    artifactId: identifier,
    version: z.number().int().positive(),
    digest,
    key: z.string().min(1).max(1_024),
    mediaType: z.literal('application/json'),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024),
    retentionClass: z.enum([
      'source-bundle',
      'cloud-session-upload',
      'working',
    ]),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const specificationOutputSchema = z
  .object({
    version: z.literal('specification-output-v1'),
    specification: artifactReferenceSchema,
    definitionOfDone: artifactReferenceSchema,
  })
  .strict();
export const planOutputSchema = z
  .object({
    version: z.literal('plan-output-v1'),
    plan: artifactReferenceSchema,
  })
  .strict();
export const implementationOutputSchema = z
  .object({
    version: z.literal('implementation-output-v1'),
    changeSet: artifactReferenceSchema,
    testEvidence: artifactReferenceSchema,
  })
  .strict();
export const reviewOutputSchema = z
  .object({
    version: z.literal('review-output-v1'),
    review: artifactReferenceSchema,
    decision: z.enum(['approved', 'changes_requested']),
  })
  .strict();

export const draftPublicationResultSchema = z
  .object({
    status: z.literal('succeeded'),
    draft: z.literal(true),
    pullRequestUrl: z.url().max(2_048),
    // The trusted publisher also reports where the draft landed; the
    // workflow records these but only the three fields above are binding.
    branch: z.string().min(1).max(512).optional(),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    pullRequestNumber: z.number().int().positive().optional(),
  })
  .strict();

export const localPublicationResultSchema = z
  .object({
    status: z.literal('succeeded'),
    local: z.literal(true),
    branch: z.string().min(1).max(512),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    repositoryUrl: z.url().max(2_048).startsWith('file://'),
  })
  .strict();

export const publicationResultSchema = z.union([
  draftPublicationResultSchema,
  localPublicationResultSchema,
]);
export type WorkflowPublicationResult = z.infer<typeof publicationResultSchema>;

export const featureSpecificationSchema = z
  .object({
    version: z.literal('feature-spec-v1'),
    title: z.string().min(1).max(200),
    requirements: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  })
  .strict();
export const definitionOfDoneSchema = z
  .object({
    version: z.literal('definition-of-done-v2'),
    criteria: z
      .array(
        z
          .object({
            id: identifier,
            description: z.string().min(1).max(2_000),
            verifier: z.literal('test-report'),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    acceptanceTests: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1_024),
            mode: z.literal('100644'),
            content: z.string().min(1).max(PUBLICATION_MAX_FILE_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = value.acceptanceTests.reduce(
      (sum, file) => sum + Buffer.byteLength(file.content),
      0,
    );
    if (bytes > PUBLICATION_MAX_TOTAL_BYTES) {
      context.addIssue({
        code: 'custom',
        message: 'acceptance tests exceed aggregate size',
      });
    }
    for (const [index, file] of value.acceptanceTests.entries()) {
      if (!isAcceptanceTestPath(file.path) || file.content.includes('\0')) {
        context.addIssue({
          code: 'custom',
          path: ['acceptanceTests'],
          message: `invalid acceptance test path: ${file.path}`,
        });
      }
      const importError = acceptanceTestImportSafetyError(file);
      if (importError !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['acceptanceTests', index, 'content'],
          message: importError,
        });
      }
    }
    const pairing = acceptanceTestsPairingError(
      value.criteria.map((criterion) => criterion.id),
      value.acceptanceTests.map((file) => file.path),
    );
    if (pairing !== undefined) {
      context.addIssue({ code: 'custom', message: pairing });
    }
  });
export const implementationPlanSchema = z
  .object({
    version: z.literal('implementation-plan-v1'),
    steps: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  })
  .strict();
const write = z
  .object({
    operation: z.enum(['add', 'modify']),
    path: z.string().min(1).max(1_024),
    mode: z.enum(['100644', '100755']),
    content: z.string().max(PUBLICATION_MAX_FILE_BYTES),
  })
  .strict();
const remove = z
  .object({
    operation: z.literal('delete'),
    path: z.string().min(1).max(1_024),
  })
  .strict();
export const changeSetSchema = z
  .object({
    version: z.literal('change-set-v1'),
    changes: z
      .array(z.discriminatedUnion('operation', [write, remove]))
      .min(1)
      .max(PUBLICATION_MAX_FILES),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = value.changes.reduce(
      (sum, change) =>
        sum + ('content' in change ? Buffer.byteLength(change.content) : 0),
      0,
    );
    if (bytes > PUBLICATION_MAX_TOTAL_BYTES)
      context.addIssue({ code: 'custom', message: 'change set is too large' });
  });
export const testEvidenceSchema = z
  .object({
    version: z.literal('test-evidence-v1'),
    passed: z.literal(true),
    command: z.string().min(1).max(2_000),
    exitCode: z.literal(0),
  })
  .strict();
export const reviewArtifactSchema = z
  .object({
    version: z.literal('review-result-v1'),
    decision: z.enum(['approved', 'changes_requested']),
    findings: z.array(z.string().max(2_000)).max(100),
  })
  .strict();

export const trustedCommandObservationSchema = z
  .object({
    runId: z.string().min(1).max(128),
    stepId: z.string().min(1).max(128),
    command: z.string().min(1).max(8_000),
    exitCode: z.number().int().min(0).max(255),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
    repositorySha: z.string().regex(/^[0-9a-f]{40}$/),
    sourceSnapshotDigest: digest,
    changeSetDigest: digest,
    configDigest: digest,
  })
  .strict();
