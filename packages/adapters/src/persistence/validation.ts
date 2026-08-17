import { canonicalJsonValue } from '@agentos/core';
import type {
  ArtifactRecord,
  ConfigRevision,
  DomainEvent,
  GoalCriterion,
  GoalProgress,
  StepRun,
  UsageRecordEntry,
} from '@agentos/core';

export function assertNonNegativeSafeInteger(
  value: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function assertPostgresInteger(
  value: number,
  field: string,
  positive: boolean,
): void {
  const minimum = positive ? 1 : 0;
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > POSTGRES_INTEGER_MAX
  ) {
    throw new TypeError(
      `${field} must be a ${positive ? 'positive' : 'non-negative'} PostgreSQL integer`,
    );
  }
}

export function assertValidUsage(usage: UsageRecordEntry): void {
  assertNonNegativeSafeInteger(usage.inputTokens, 'inputTokens');
  assertNonNegativeSafeInteger(usage.outputTokens, 'outputTokens');
  assertNonNegativeSafeInteger(
    usage.cacheReadInputTokens,
    'cacheReadInputTokens',
  );
  assertNonNegativeSafeInteger(
    usage.cacheCreation5mInputTokens,
    'cacheCreation5mInputTokens',
  );
  assertNonNegativeSafeInteger(
    usage.cacheCreation1hInputTokens,
    'cacheCreation1hInputTokens',
  );
  assertNonNegativeSafeInteger(usage.runtimeMs, 'runtimeMs');
  assertNonNegativeSafeInteger(usage.microdollars, 'microdollars');
}

export function assertValidEvent(event: DomainEvent): void {
  assertNonNegativeSafeInteger(event.sequence, 'sequence');
}

export function assertValidArtifact(artifact: ArtifactRecord): void {
  if (artifact.sizeBytes !== undefined) {
    assertNonNegativeSafeInteger(artifact.sizeBytes, 'sizeBytes');
  }
}

export function assertValidConfigRevision(revision: ConfigRevision): void {
  assertPostgresInteger(revision.revision, 'revision', true);
}

export function assertValidStepRun(step: StepRun): void {
  assertPostgresInteger(step.attempt, 'attempt', true);
}

export function assertValidGoalCriterion(criterion: GoalCriterion): void {
  assertPostgresInteger(criterion.ordinal, 'ordinal', false);
}

export function assertValidGoalProgress(progress: GoalProgress): void {
  assertPostgresInteger(progress.step, 'step', true);
  if (progress.step > 3) throw new TypeError('step must be between 1 and 3');
}

export function sameGoalCriterion(
  existing: GoalCriterion,
  requested: GoalCriterion,
): boolean {
  return (
    existing.id === requested.id &&
    existing.runId === requested.runId &&
    existing.ordinal === requested.ordinal &&
    existing.description === requested.description &&
    existing.status === requested.status &&
    canonicalJsonValue(existing.definition) ===
      canonicalJsonValue(requested.definition)
  );
}

export function sameGoalProgress(
  existing: GoalProgress,
  requested: GoalProgress,
): boolean {
  return (
    existing.id === requested.id &&
    existing.runId === requested.runId &&
    existing.criterionId === requested.criterionId &&
    existing.step === requested.step &&
    existing.status === requested.status &&
    existing.detail === requested.detail &&
    (existing.payload === undefined
      ? requested.payload === undefined
      : requested.payload !== undefined &&
        canonicalJsonValue(existing.payload) ===
          canonicalJsonValue(requested.payload))
  );
}
