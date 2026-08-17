import type { UsageRecordEntry } from '@agentos/core';

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

export function assertValidUsage(usage: UsageRecordEntry): void {
  assertNonNegativeSafeInteger(usage.inputTokens, 'inputTokens');
  assertNonNegativeSafeInteger(usage.outputTokens, 'outputTokens');
  assertNonNegativeSafeInteger(usage.runtimeMs, 'runtimeMs');
  assertNonNegativeSafeInteger(usage.microdollars, 'microdollars');
}
