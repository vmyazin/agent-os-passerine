import {
  PUBLICATION_MAX_FILE_BYTES,
  PUBLICATION_MAX_FILES,
  PUBLICATION_MAX_TOTAL_BYTES,
} from '@agentos/core';
import { z } from 'zod';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const featureWorkflowInputSchema = z
  .object({
    version: z.literal('feature-workflow-input-v1'),
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
  })
  .strict();

export const featureSpecificationSchema = z
  .object({
    version: z.literal('feature-spec-v1'),
    title: z.string().min(1).max(200),
    requirements: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  })
  .strict();
export const definitionOfDoneSchema = z
  .object({
    version: z.literal('definition-of-done-v1'),
    criteria: z
      .array(
        z
          .object({
            id: identifier,
            description: z.string().min(1).max(2_000),
            verifier: z.enum([
              'command-result',
              'required-artifact',
              'test-report',
              'pr-state',
              'human-check',
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
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
