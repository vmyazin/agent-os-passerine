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

function ownValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
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
  readonly reservations: Readonly<Record<string, BudgetReservation>>;
  readonly settledReservations: Readonly<Record<string, SettledReservation>>;
  readonly settledReservationIds: readonly string[];
}

export interface BudgetReservation {
  readonly id: string;
  readonly workflowId: string;
  readonly microdollars: Microdollars;
}

export interface SettledReservation {
  readonly id: string;
  readonly requestFingerprint: string;
  readonly outcome: 'consumed' | 'released';
  readonly actualMicrodollars?: Microdollars;
}

export function createUsageLedger(day: string): UsageLedger {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new Error('Ledger day must use YYYY-MM-DD');
  return {
    day,
    dailySpentMicrodollars: 0,
    workflowSpentMicrodollars: {},
    activeWorkflowIds: [],
    reservations: {},
    settledReservations: {},
    settledReservationIds: [],
  };
}

export function recordUsageCost(
  ledger: UsageLedger,
  workflowId: string,
  microdollars: Microdollars,
): UsageLedger {
  const amount = requireNonNegativeInteger(microdollars, 'microdollars');
  const workflowSpent = requireNonNegativeInteger(
    ownValue(ledger.workflowSpentMicrodollars, workflowId) ?? 0,
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

export interface BudgetReservationRequest extends AdmissionRequest {
  readonly reservationId: string;
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

function reservationTotal(ledger: UsageLedger, workflowId?: string): bigint {
  let total = 0n;
  for (const reservation of Object.values(ledger.reservations)) {
    if (workflowId === undefined || reservation.workflowId === workflowId) {
      total += requireNonNegativeInteger(
        reservation.microdollars,
        'reservation microdollars',
      );
    }
  }
  return total;
}

function reservedWorkflowIds(ledger: UsageLedger): Set<string> {
  return new Set([
    ...ledger.activeWorkflowIds,
    ...Object.values(ledger.reservations).map(({ workflowId }) => workflowId),
  ]);
}

export function decideBudgetAction(
  ledger: UsageLedger,
  request: AdmissionRequest,
  limits: BudgetLimits,
): BudgetDecision {
  const workflowSpent = requireNonNegativeInteger(
    ownValue(ledger.workflowSpentMicrodollars, request.workflowId) ?? 0,
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
  const workflowCommitted =
    workflowSpent + reservationTotal(ledger, request.workflowId);
  const dailyCommitted = dailySpent + reservationTotal(ledger);
  if (workflowCommitted >= workflowCap)
    return { decision: 'exhaust', reason: 'workflow_cap' };
  if (dailyCommitted >= dailyCap)
    return { decision: 'exhaust', reason: 'daily_cap' };
  if (!Number.isSafeInteger(limits.concurrency) || limits.concurrency <= 0)
    throw new Error('concurrency must be a positive safe integer');
  const occupiedWorkflowIds = reservedWorkflowIds(ledger);
  if (
    !occupiedWorkflowIds.has(request.workflowId) &&
    occupiedWorkflowIds.size >= limits.concurrency
  ) {
    return { decision: 'cancel', reason: 'concurrency_limit' };
  }
  const reservePercent = limits.admissionReservePercent ?? 80;
  if (reservePercent < 0 || reservePercent > 100)
    throw new Error('admission reserve percent must be between 0 and 100');
  if (
    workflowCommitted + estimate >
      reservedLimit(limits.workflowMicrodollars, reservePercent) ||
    dailyCommitted + estimate >
      reservedLimit(limits.dailyMicrodollars, reservePercent)
  ) {
    return { decision: 'cancel', reason: 'admission_reserve' };
  }
  return { decision: 'admit', reason: 'within_limits' };
}

export type BudgetReservationResult =
  | (BudgetDecision & {
      readonly ledger: UsageLedger;
      readonly shouldExecute: boolean;
    })
  | {
      readonly decision: 'replay';
      readonly reason: 'settled';
      readonly settlement: SettledReservation['outcome'];
      readonly shouldExecute: false;
      readonly ledger: UsageLedger;
    };

export function reserveBudget(
  ledger: UsageLedger,
  request: BudgetReservationRequest,
  limits: BudgetLimits,
): BudgetReservationResult {
  if (request.reservationId.trim() === '')
    throw new Error('reservationId must be non-empty');
  const requestFingerprint = JSON.stringify([
    request.workflowId,
    request.estimatedMicrodollars,
  ]);
  const existing = ownValue(ledger.reservations, request.reservationId);
  if (existing !== undefined) {
    if (
      existing.workflowId !== request.workflowId ||
      existing.microdollars !== request.estimatedMicrodollars
    )
      throw new Error('Reservation ID was reused with different details');
    return {
      decision: 'admit',
      reason: 'within_limits',
      shouldExecute: false,
      ledger,
    };
  }
  const settled = ownValue(ledger.settledReservations, request.reservationId);
  if (settled !== undefined) {
    if (settled.requestFingerprint !== requestFingerprint)
      throw new Error('Reservation ID was reused with different details');
    return {
      decision: 'replay',
      reason: 'settled',
      settlement: settled.outcome,
      shouldExecute: false,
      ledger,
    };
  }
  const decision = decideBudgetAction(ledger, request, limits);
  if (decision.decision !== 'admit')
    return { ...decision, shouldExecute: false, ledger };
  const microdollars = toMicrodollars(
    requireNonNegativeInteger(
      request.estimatedMicrodollars,
      'estimated microdollars',
    ),
  );
  return {
    ...decision,
    shouldExecute: true,
    ledger: {
      ...ledger,
      reservations: {
        ...ledger.reservations,
        [request.reservationId]: {
          id: request.reservationId,
          workflowId: request.workflowId,
          microdollars,
        },
      },
    },
  };
}

function withoutReservation(
  ledger: UsageLedger,
  reservationId: string,
): UsageLedger {
  return {
    ...ledger,
    reservations: Object.fromEntries(
      Object.entries(ledger.reservations).filter(
        ([id]) => id !== reservationId,
      ),
    ),
  };
}

function settleReservation(
  ledger: UsageLedger,
  reservation: BudgetReservation,
  outcome: SettledReservation['outcome'],
  actualMicrodollars?: Microdollars,
): UsageLedger {
  const settledReservationIds = [
    ...ledger.settledReservationIds,
    reservation.id,
  ];
  const settledReservations: Record<string, SettledReservation> = {
    ...ledger.settledReservations,
    [reservation.id]: {
      id: reservation.id,
      requestFingerprint: JSON.stringify([
        reservation.workflowId,
        reservation.microdollars,
      ]),
      outcome,
      ...(actualMicrodollars === undefined ? {} : { actualMicrodollars }),
    },
  };
  return { ...ledger, settledReservationIds, settledReservations };
}

export function releaseBudgetReservation(
  ledger: UsageLedger,
  reservationId: string,
): UsageLedger {
  const reservation = ownValue(ledger.reservations, reservationId);
  if (reservation === undefined) {
    const settled = ownValue(ledger.settledReservations, reservationId);
    if (settled === undefined || settled.outcome === 'released') return ledger;
    throw new Error('Reservation was already consumed');
  }
  return settleReservation(
    withoutReservation(ledger, reservationId),
    reservation,
    'released',
  );
}

export function consumeBudgetReservation(
  ledger: UsageLedger,
  reservationId: string,
  actualMicrodollars: Microdollars,
): UsageLedger {
  const reservation = ownValue(ledger.reservations, reservationId);
  if (reservation === undefined) {
    const settled = ownValue(ledger.settledReservations, reservationId);
    if (
      settled?.outcome === 'consumed' &&
      settled.actualMicrodollars === actualMicrodollars
    )
      return ledger;
    if (settled !== undefined)
      throw new Error(
        'Reservation settlement was replayed with different details',
      );
    throw new Error(`Unknown budget reservation: ${reservationId}`);
  }
  const recorded = recordUsageCost(
    withoutReservation(ledger, reservationId),
    reservation.workflowId,
    actualMicrodollars,
  );
  return settleReservation(
    recorded,
    reservation,
    'consumed',
    actualMicrodollars,
  );
}

export const calculateCost = calculateUsageCost;
