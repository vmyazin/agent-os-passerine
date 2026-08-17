export type Microdollars = number;

export interface UsageQuantity {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runtimeMs: number;
}

export interface ModelRates {
  readonly inputMicrodollarsPerMillionTokens: Microdollars;
  readonly outputMicrodollarsPerMillionTokens: Microdollars;
  readonly runtimeMicrodollarsPerMinute: Microdollars;
}

function requireNonNegativeInteger(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
  return BigInt(value);
}

function divideUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function toMicrodollars(value: bigint): Microdollars {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Microdollar total exceeds the safe integer range');
  return Number(value);
}

export function calculateUsageCost(
  usage: UsageQuantity,
  rates: ModelRates,
): Microdollars {
  const input = divideUp(
    requireNonNegativeInteger(usage.inputTokens, 'inputTokens') *
      requireNonNegativeInteger(
        rates.inputMicrodollarsPerMillionTokens,
        'input rate',
      ),
    1_000_000n,
  );
  const output = divideUp(
    requireNonNegativeInteger(usage.outputTokens, 'outputTokens') *
      requireNonNegativeInteger(
        rates.outputMicrodollarsPerMillionTokens,
        'output rate',
      ),
    1_000_000n,
  );
  const runtime = divideUp(
    requireNonNegativeInteger(usage.runtimeMs, 'runtimeMs') *
      requireNonNegativeInteger(
        rates.runtimeMicrodollarsPerMinute,
        'runtime rate',
      ),
    60_000n,
  );
  return toMicrodollars(input + output + runtime);
}

export interface UsageLedger {
  readonly day: string;
  readonly dailySpentMicrodollars: Microdollars;
  readonly workflowSpentMicrodollars: Readonly<Record<string, Microdollars>>;
  readonly activeWorkflowIds: readonly string[];
}

export function createUsageLedger(day: string): UsageLedger {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new Error('Ledger day must use YYYY-MM-DD');
  return {
    day,
    dailySpentMicrodollars: 0,
    workflowSpentMicrodollars: {},
    activeWorkflowIds: [],
  };
}

export function recordUsageCost(
  ledger: UsageLedger,
  workflowId: string,
  microdollars: Microdollars,
): UsageLedger {
  const amount = requireNonNegativeInteger(microdollars, 'microdollars');
  const workflowSpent = requireNonNegativeInteger(
    ledger.workflowSpentMicrodollars[workflowId] ?? 0,
    'workflow spent',
  );
  const dailySpent = requireNonNegativeInteger(
    ledger.dailySpentMicrodollars,
    'daily spent',
  );
  return {
    ...ledger,
    dailySpentMicrodollars: toMicrodollars(dailySpent + amount),
    workflowSpentMicrodollars: {
      ...ledger.workflowSpentMicrodollars,
      [workflowId]: toMicrodollars(workflowSpent + amount),
    },
  };
}

export function recordUsage(
  ledger: UsageLedger,
  workflowId: string,
  usage: UsageQuantity,
  rates: ModelRates,
): UsageLedger {
  return recordUsageCost(ledger, workflowId, calculateUsageCost(usage, rates));
}

export function markWorkflowActive(
  ledger: UsageLedger,
  workflowId: string,
): UsageLedger {
  if (ledger.activeWorkflowIds.includes(workflowId)) return ledger;
  return {
    ...ledger,
    activeWorkflowIds: [...ledger.activeWorkflowIds, workflowId].sort(),
  };
}

export function markWorkflowInactive(
  ledger: UsageLedger,
  workflowId: string,
): UsageLedger {
  if (!ledger.activeWorkflowIds.includes(workflowId)) return ledger;
  return {
    ...ledger,
    activeWorkflowIds: ledger.activeWorkflowIds.filter(
      (id) => id !== workflowId,
    ),
  };
}

export interface BudgetLimits {
  readonly workflowMicrodollars: Microdollars;
  readonly dailyMicrodollars: Microdollars;
  readonly concurrency: number;
  readonly admissionReservePercent?: number;
}

export interface AdmissionRequest {
  readonly workflowId: string;
  readonly estimatedMicrodollars: Microdollars;
}

export type BudgetDecision =
  | { readonly decision: 'admit'; readonly reason: 'within_limits' }
  | {
      readonly decision: 'cancel';
      readonly reason: 'concurrency_limit' | 'admission_reserve';
    }
  | {
      readonly decision: 'exhaust';
      readonly reason: 'workflow_cap' | 'daily_cap';
    };

function reservedLimit(limit: number, percent: number): bigint {
  return (
    (requireNonNegativeInteger(limit, 'budget limit') *
      requireNonNegativeInteger(percent, 'admission reserve percent')) /
    100n
  );
}

export function decideBudgetAction(
  ledger: UsageLedger,
  request: AdmissionRequest,
  limits: BudgetLimits,
): BudgetDecision {
  const workflowSpent = requireNonNegativeInteger(
    ledger.workflowSpentMicrodollars[request.workflowId] ?? 0,
    'workflow spent',
  );
  const dailySpent = requireNonNegativeInteger(
    ledger.dailySpentMicrodollars,
    'daily spent',
  );
  const workflowCap = requireNonNegativeInteger(
    limits.workflowMicrodollars,
    'workflow cap',
  );
  const dailyCap = requireNonNegativeInteger(
    limits.dailyMicrodollars,
    'daily cap',
  );
  const estimate = requireNonNegativeInteger(
    request.estimatedMicrodollars,
    'estimated microdollars',
  );
  if (workflowSpent >= workflowCap)
    return { decision: 'exhaust', reason: 'workflow_cap' };
  if (dailySpent >= dailyCap)
    return { decision: 'exhaust', reason: 'daily_cap' };
  if (!Number.isSafeInteger(limits.concurrency) || limits.concurrency <= 0)
    throw new Error('concurrency must be a positive safe integer');
  if (
    !ledger.activeWorkflowIds.includes(request.workflowId) &&
    ledger.activeWorkflowIds.length >= limits.concurrency
  ) {
    return { decision: 'cancel', reason: 'concurrency_limit' };
  }
  const reservePercent = limits.admissionReservePercent ?? 80;
  if (reservePercent < 0 || reservePercent > 100)
    throw new Error('admission reserve percent must be between 0 and 100');
  if (
    workflowSpent + estimate >
      reservedLimit(limits.workflowMicrodollars, reservePercent) ||
    dailySpent + estimate >
      reservedLimit(limits.dailyMicrodollars, reservePercent)
  ) {
    return { decision: 'cancel', reason: 'admission_reserve' };
  }
  return { decision: 'admit', reason: 'within_limits' };
}

export const calculateCost = calculateUsageCost;
