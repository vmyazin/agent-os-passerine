import { createHash } from 'node:crypto';
import type { AttestationVerifier, SignedAttestation } from './attestation.js';

interface CriterionBase {
  readonly id: string;
  readonly description: string;
  readonly required?: boolean;
}

export interface CommandCriterion extends CriterionBase {
  readonly type: 'command';
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface ArtifactCriterion extends CriterionBase {
  readonly type: 'artifact';
  readonly key: string;
  readonly mediaType?: string;
}

export interface PullRequestCheckCriterion extends CriterionBase {
  readonly type: 'pr-check';
  readonly check: string;
}

export interface HumanCriterion extends CriterionBase {
  readonly type: 'human';
  readonly prompt: string;
}

export type DefinitionOfDoneCriterion =
  | CommandCriterion
  | ArtifactCriterion
  | PullRequestCheckCriterion
  | HumanCriterion;

export type CriterionType = DefinitionOfDoneCriterion['type'];

export interface EvidenceSubmissionRequest {
  readonly id: string;
  readonly criterionId: string;
  readonly submittedByAgentId: string;
  readonly observedAt: Date;
  readonly payload: unknown;
}

export interface EvidenceSubmission extends EvidenceSubmissionRequest {
  readonly status: 'submitted';
}

export function submitEvidence(
  request: EvidenceSubmissionRequest,
): EvidenceSubmission {
  return { ...request, status: 'submitted' };
}

export interface VerifierFinding {
  readonly passed: boolean;
  readonly message: string;
  readonly code?: string;
  readonly details?: unknown;
}

export interface VerifierAttestationClaims extends VerifierFinding {
  readonly source: 'registered-verifier';
  readonly verifierId: string;
  readonly criterionId: string;
  readonly evidenceId: string;
}

export type VerifierAttestation = SignedAttestation<VerifierAttestationClaims>;

export interface DefinitionOfDoneVerifier {
  readonly id: string;
  readonly attestationVerifier: AttestationVerifier<VerifierAttestationClaims>;
  verify(
    criterion: DefinitionOfDoneCriterion,
    evidence: EvidenceSubmission,
  ): Promise<VerifierAttestation> | VerifierAttestation;
}

export type VerifierRegistry = Readonly<
  Partial<Record<CriterionType, DefinitionOfDoneVerifier>>
>;

export function createVerifierRegistry(): VerifierRegistry {
  return {};
}

export function registerVerifier(
  registry: VerifierRegistry,
  type: CriterionType,
  verifier: DefinitionOfDoneVerifier,
): VerifierRegistry {
  return { ...registry, [type]: verifier };
}

export interface FailureFingerprintInput {
  readonly criterionId: string;
  readonly verifierId: string;
  readonly code: string;
  readonly message: string;
}

function normalizeFingerprintText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function createFailureFingerprint(
  input: FailureFingerprintInput,
): string {
  const normalized = {
    code: normalizeFingerprintText(input.code),
    criterionId: normalizeFingerprintText(input.criterionId),
    message: normalizeFingerprintText(input.message),
    verifierId: normalizeFingerprintText(input.verifierId),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export type VerificationResult =
  | {
      readonly status: 'passed';
      readonly criterionId: string;
      readonly verifierId: string;
      readonly message: string;
      readonly attestation: VerifierAttestation;
    }
  | {
      readonly status: 'failed';
      readonly criterionId: string;
      readonly verifierId?: string;
      readonly code: string;
      readonly message: string;
      readonly fingerprint: string;
    };

function failedResult(
  criterionId: string,
  verifierId: string,
  code: string,
  message: string,
): VerificationResult {
  return {
    status: 'failed',
    criterionId,
    verifierId,
    code,
    message,
    fingerprint: createFailureFingerprint({
      criterionId,
      verifierId,
      code,
      message,
    }),
  };
}

export async function verifyCriterion(
  registry: VerifierRegistry,
  criterion: DefinitionOfDoneCriterion,
  evidence: EvidenceSubmission,
): Promise<VerificationResult> {
  if (evidence.criterionId !== criterion.id) {
    return failedResult(
      criterion.id,
      'registry',
      'evidence_mismatch',
      'Evidence belongs to another criterion',
    );
  }
  const verifier = registry[criterion.type];
  if (verifier === undefined) {
    return failedResult(
      criterion.id,
      'registry',
      'verifier_not_registered',
      `No verifier is registered for ${criterion.type}`,
    );
  }
  const attestation = await verifier.verify(criterion, evidence);
  const finding = verifier.attestationVerifier.verify(attestation, {
    kind: 'definition-of-done-verification',
    subject: `${verifier.id}:${criterion.id}:${evidence.id}`,
  });
  if (
    finding === undefined ||
    finding.source !== 'registered-verifier' ||
    finding.verifierId !== verifier.id ||
    finding.criterionId !== criterion.id ||
    finding.evidenceId !== evidence.id
  ) {
    return failedResult(
      criterion.id,
      verifier.id,
      'attestation_mismatch',
      'Verifier attestation is not bound to this criterion and evidence',
    );
  }
  if (finding.passed) {
    return {
      status: 'passed',
      criterionId: criterion.id,
      verifierId: verifier.id,
      message: finding.message,
      attestation,
    };
  }
  return failedResult(
    criterion.id,
    verifier.id,
    finding.code ?? 'verification_failed',
    finding.message,
  );
}

export interface StuckDetection {
  readonly stuck: boolean;
  readonly fingerprint?: string;
  readonly occurrences: number;
}

export function detectStuck(
  failureFingerprints: readonly string[],
  threshold = 3,
): StuckDetection {
  if (!Number.isSafeInteger(threshold) || threshold <= 0)
    throw new Error('Stuck threshold must be a positive integer');
  const counts = new Map<string, number>();
  for (const fingerprint of failureFingerprints) {
    const occurrences = (counts.get(fingerprint) ?? 0) + 1;
    counts.set(fingerprint, occurrences);
    if (occurrences >= threshold)
      return { stuck: true, fingerprint, occurrences };
  }
  const occurrences = Math.max(0, ...counts.values());
  return { stuck: false, occurrences };
}

export type DoDCriterion = DefinitionOfDoneCriterion;
export type PRCheckCriterion = PullRequestCheckCriterion;
