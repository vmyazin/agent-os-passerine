import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  validateArtifactMetadata,
  type ArtifactMetadata,
  type ArtifactStore,
  type DefinitionOfDoneCriterion,
  type DefinitionOfDoneVerifier,
  type EvidenceSubmission,
  type HmacAttestationKey,
  type VerifierAttestation,
  type VerifierAttestationClaims,
} from '@agentos/core';
import { z } from 'zod';

const MAX_REPORT_BYTES = 1024 * 1024;
const verifierId = 'trusted-goal-command';
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const artifactSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    stepId: z.string().min(1).max(128),
    artifactId: z.string().min(1).max(128),
    version: z.number().int().positive(),
    digest,
    key: z.string().min(1).max(2_000),
    mediaType: z.string().min(1).max(256),
    sizeBytes: z.number().int().nonnegative().max(MAX_REPORT_BYTES),
    retentionClass: z.enum([
      'source-bundle',
      'cloud-session-upload',
      'working',
    ]),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const evidencePayloadSchema = z
  .object({
    version: z.literal('goal-command-evidence-v1'),
    parentRunId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    childRunId: z.string().min(1).max(128),
    artifact: artifactSchema,
  })
  .strict();
const observationSchema = z
  .object({
    runId: z.string().min(1).max(128),
    stepId: z.literal('verification'),
    command: z.string().min(1).max(8_000),
    exitCode: z.number().int(),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
    repositorySha: z.string().regex(/^[0-9a-f]{40}$/),
    sourceSnapshotDigest: digest,
    changeSetDigest: digest,
    configDigest: digest,
  })
  .strict();
const reportEvidenceSchema = z
  .object({
    version: z.literal('workflow-verification-v3'),
    runId: z.string().min(1).max(128),
    trustedCommandObservation: observationSchema,
  })
  .passthrough();
const reportSchema = z
  .object({
    version: z.literal('trusted-test-report-v1'),
    evidence: z.unknown(),
    attestation: z.unknown(),
  })
  .strict();
const reportClaimsSchema = z
  .object({
    source: z.literal('managed-agent-command-observer'),
    runId: z.string().min(1).max(128),
    evidenceDigest: digest,
  })
  .strict();

class GoalVerificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoalVerificationError';
  }
}

function fail(code: string, message: string): never {
  throw new GoalVerificationError(code, message);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonValue(value)).digest('hex');
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function findingAttestation(
  issuer: ReturnType<
    typeof createHmacAttestationIssuer<VerifierAttestationClaims>
  >,
  clock: () => string,
  criterion: Pick<DefinitionOfDoneCriterion, 'id'>,
  evidence: EvidenceSubmission,
  finding: {
    readonly passed: boolean;
    readonly code?: string;
    readonly message: string;
    readonly details?: unknown;
  },
): VerifierAttestation {
  return issuer.issue({
    subject: `${verifierId}:${criterion.id}:${evidence.id}`,
    issuedAt: clock(),
    claims: {
      source: 'registered-verifier',
      verifierId,
      criterionId: criterion.id,
      evidenceId: evidence.id,
      ...finding,
    },
  });
}

function assertArtifactBinding(
  artifact: ArtifactMetadata,
  value: Awaited<ReturnType<ArtifactStore['get']>>,
): asserts value is NonNullable<typeof value> {
  if (value === undefined)
    fail('report_missing', 'Trusted test report is missing');
  if (
    value.key !== artifact.key ||
    value.projectId !== artifact.projectId ||
    value.runId !== artifact.runId ||
    value.stepId !== artifact.stepId ||
    value.artifactId !== artifact.artifactId ||
    value.version !== artifact.version ||
    value.digest !== artifact.digest ||
    value.sizeBytes !== artifact.sizeBytes ||
    value.mediaType !== artifact.mediaType ||
    hashBytes(value.bytes) !== artifact.digest
  )
    fail(
      'report_artifact_mismatch',
      'Trusted test report artifact is mismatched',
    );
}

export interface TrustedGoalCommandVerifierOptions {
  readonly artifacts: ArtifactStore;
  readonly keys: readonly HmacAttestationKey[];
  readonly clock?: () => string;
}

export function createTrustedGoalCommandVerifier(
  options: TrustedGoalCommandVerifierOptions,
): DefinitionOfDoneVerifier {
  const activeKey = options.keys[0];
  if (activeKey === undefined)
    throw new Error('at least one trusted test report key is required');
  const reportVerifier = createHmacAttestationVerifier({
    kind: 'trusted-test-report',
    keys: options.keys,
  });
  const attestationIssuer =
    createHmacAttestationIssuer<VerifierAttestationClaims>({
      ...activeKey,
      kind: 'definition-of-done-verification',
    });
  const attestationVerifier =
    createHmacAttestationVerifier<VerifierAttestationClaims>({
      kind: 'definition-of-done-verification',
      keys: options.keys,
    });
  const clock = options.clock ?? (() => new Date().toISOString());

  const verifier: DefinitionOfDoneVerifier = {
    id: verifierId,
    attestationVerifier,
    async verify(
      criterion: DefinitionOfDoneCriterion,
      evidence: EvidenceSubmission,
    ) {
      if (criterion.type !== 'command')
        return findingAttestation(
          attestationIssuer,
          clock,
          criterion,
          evidence,
          {
            passed: false,
            code: 'unsupported_criterion',
            message: 'Trusted goal verifier accepts only command criteria',
          },
        );
      try {
        const payload = evidencePayloadSchema.parse(evidence.payload);
        const artifact = validateArtifactMetadata(
          payload.artifact as ArtifactMetadata,
        );
        if (
          artifact.projectId !== payload.projectId ||
          artifact.runId !== payload.childRunId ||
          artifact.stepId !== 'verification' ||
          artifact.artifactId !== 'trusted-test-report' ||
          artifact.version !== 1 ||
          artifact.mediaType !== 'application/json'
        )
          fail(
            'report_artifact_mismatch',
            'Trusted test report artifact binding is invalid',
          );
        const value = await options.artifacts.get({
          scope: {
            projectId: payload.projectId,
            runId: payload.childRunId,
            stepId: 'verification',
          },
          key: artifact.key,
          maxBytes: MAX_REPORT_BYTES,
        });
        assertArtifactBinding(artifact, value);
        let decoded: unknown;
        try {
          decoded = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(value.bytes),
          );
        } catch {
          fail('report_malformed', 'Trusted test report is malformed');
        }
        const report = reportSchema.parse(decoded);
        const reportEvidence = reportEvidenceSchema.parse(report.evidence);
        const evidenceDigest = hash(report.evidence);
        const rawClaims = reportVerifier.verify(report.attestation, {
          subject: `${payload.childRunId}:verification:${evidenceDigest}`,
        });
        if (rawClaims === undefined)
          fail(
            'report_attestation_invalid',
            'Trusted test report attestation is invalid',
          );
        const claims = reportClaimsSchema.parse(rawClaims);
        if (
          claims.runId !== payload.childRunId ||
          claims.evidenceDigest !== evidenceDigest ||
          reportEvidence.runId !== payload.childRunId ||
          reportEvidence.trustedCommandObservation.runId !== payload.childRunId
        )
          fail(
            'report_run_mismatch',
            'Trusted test report child run binding is invalid',
          );
        const observation = reportEvidence.trustedCommandObservation;
        if (observation.command !== criterion.command)
          fail(
            'report_command_mismatch',
            'Trusted test report command does not match the criterion',
          );
        const startedAt = Date.parse(observation.startedAt);
        const completedAt = Date.parse(observation.completedAt);
        if (
          observation.exitCode !== 0 ||
          completedAt < startedAt ||
          !Number.isFinite(evidence.observedAt.getTime()) ||
          evidence.observedAt.getTime() < completedAt
        )
          fail(
            'report_command_failed',
            'Trusted test report command did not complete successfully',
          );
        return findingAttestation(
          attestationIssuer,
          clock,
          criterion,
          evidence,
          {
            passed: true,
            message: 'Trusted child command report passed',
            details: {
              parentRunId: payload.parentRunId,
              childRunId: payload.childRunId,
              artifactDigest: artifact.digest,
              evidenceDigest,
            },
          },
        );
      } catch (error) {
        const finding =
          error instanceof GoalVerificationError
            ? { code: error.code, message: error.message }
            : {
                code: 'trusted_report_invalid',
                message: 'Trusted test report is invalid',
              };
        return findingAttestation(
          attestationIssuer,
          clock,
          criterion,
          evidence,
          { passed: false, ...finding },
        );
      }
    },
  };
  return Object.freeze(verifier);
}
