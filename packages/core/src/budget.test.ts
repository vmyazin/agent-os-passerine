import { describe, expect, it } from 'vitest';

import {
  calculateUsageCost,
  createUsageLedger,
  decideBudgetAction,
  recordUsageCost,
  type BudgetLimits,
} from './budget.js';

const limits: BudgetLimits = {
  workflowMicrodollars: 1_000,
  dailyMicrodollars: 10_000,
  concurrency: 2,
  admissionReservePercent: 80,
};

describe('integer usage accounting', () => {
  it('calculates token and runtime cost in integer microdollars', () => {
    expect(
      calculateUsageCost(
        { inputTokens: 1_000, outputTokens: 500, runtimeMs: 30_000 },
        {
          inputMicrodollarsPerMillionTokens: 2_000_000,
          outputMicrodollarsPerMillionTokens: 4_000_000,
          runtimeMicrodollarsPerMinute: 60_000,
        },
      ),
    ).toBe(34_000);
  });

  it('rounds fractional microdollars upward without floating-point arithmetic', () => {
    expect(
      calculateUsageCost(
        { inputTokens: 1, outputTokens: 0, runtimeMs: 0 },
        {
          inputMicrodollarsPerMillionTokens: 1,
          outputMicrodollarsPerMillionTokens: 0,
          runtimeMicrodollarsPerMinute: 0,
        },
      ),
    ).toBe(1);
  });
});

describe('budget decisions', () => {
  it('admits work only within the 80 percent reserve threshold', () => {
    const ledger = recordUsageCost(
      createUsageLedger('2026-08-16'),
      'run-1',
      700,
    );

    expect(
      decideBudgetAction(
        ledger,
        { workflowId: 'run-1', estimatedMicrodollars: 100 },
        limits,
      ).decision,
    ).toBe('admit');
    expect(
      decideBudgetAction(
        ledger,
        { workflowId: 'run-1', estimatedMicrodollars: 101 },
        limits,
      ).decision,
    ).toBe('cancel');
  });

  it('cancels admission when concurrency is full', () => {
    const ledger = {
      ...createUsageLedger('2026-08-16'),
      activeWorkflowIds: ['one', 'two'],
    };

    expect(
      decideBudgetAction(
        ledger,
        { workflowId: 'three', estimatedMicrodollars: 1 },
        limits,
      ),
    ).toMatchObject({
      decision: 'cancel',
      reason: 'concurrency_limit',
    });
  });

  it('exhausts deterministically at workflow or daily caps', () => {
    const workflowSpent = recordUsageCost(
      createUsageLedger('2026-08-16'),
      'run-1',
      1_000,
    );
    const dailySpent = recordUsageCost(
      createUsageLedger('2026-08-16'),
      'other',
      10_000,
    );

    expect(
      decideBudgetAction(
        workflowSpent,
        { workflowId: 'run-1', estimatedMicrodollars: 0 },
        limits,
      ).decision,
    ).toBe('exhaust');
    expect(
      decideBudgetAction(
        dailySpent,
        { workflowId: 'run-1', estimatedMicrodollars: 0 },
        limits,
      ).decision,
    ).toBe('exhaust');
  });
});
