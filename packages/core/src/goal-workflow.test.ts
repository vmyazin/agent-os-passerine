import { describe, expect, it } from 'vitest';

import { createHmacAttestationIssuer } from './attestation.js';
import type {
  CommandCriterion,
  VerificationResult,
  VerifierAttestationClaims,
} from './dod.js';
import {
  createGoalWorkflow,
  reduceGoalWorkflow,
  replayGoalWorkflow,
  type GoalWorkflowEvent,
} from './goal-workflow.js';

const criteria: CommandCriterion[] = [
  {
    id: 'unit-tests',
    type: 'command',
    description: 'Unit tests pass',
    required: true,
    command: 'pnpm test',
  },
  {
    id: 'typecheck',
    type: 'command',
    description: 'Typecheck passes',
    required: true,
    command: 'pnpm typecheck',
  },
];

const verifierIssuer = createHmacAttestationIssuer<VerifierAttestationClaims>({
  keyId: 'goal-test-verifier',
  secret: 'goal-test-verifier-secret-material!',
  kind: 'definition-of-done-verification',
});

function passed(criterionId: string): VerificationResult {
  return {
    status: 'passed',
    criterionId,
    verifierId: 'trusted-command',
    message: 'passed',
    attestation: verifierIssuer.issue({
      subject: `evidence-${criterionId}`,
      claims: {
        source: 'registered-verifier',
        verifierId: 'trusted-command',
        criterionId,
        evidenceId: `evidence-${criterionId}`,
        passed: true,
        message: 'passed',
      },
      issuedAt: '2026-08-17T12:00:00.000Z',
    }),
  };
}

function failed(criterionId: string, fingerprint: string): VerificationResult {
  return {
    status: 'failed',
    criterionId,
    verifierId: 'trusted-command',
    code: 'command_failed',
    message: 'failed',
    fingerprint,
  };
}

function stepEvent(
  id: string,
  step: number,
  results: readonly VerificationResult[],
): GoalWorkflowEvent {
  return { id, type: 'step_evaluated', step, results };
}

const start: GoalWorkflowEvent = { id: 'start', type: 'start' };

describe('goal workflow reducer', () => {
  it('creates a bounded pending goal with immutable command criteria', () => {
    const supplied = criteria.map((criterion) => ({ ...criterion }));
    const state = createGoalWorkflow({ criteria: supplied, maxSteps: 3 });
    supplied[0]!.command = 'changed after creation';

    expect(state).toMatchObject({
      status: 'pending',
      currentStep: 0,
      maxSteps: 3,
    });
    expect(state.criteria[0]?.command).toBe('pnpm test');
    expect(Object.isFrozen(state.criteria)).toBe(true);
    expect(Object.isFrozen(state.criteria[0])).toBe(true);
  });

  it('ignores an exact duplicate event and rejects a conflicting duplicate', () => {
    const running = reduceGoalWorkflow(
      createGoalWorkflow({ criteria, maxSteps: 3 }),
      start,
    );

    expect(reduceGoalWorkflow(running, start)).toBe(running);
    expect(() =>
      reduceGoalWorkflow(running, { id: 'start', type: 'cancel' }),
    ).toThrow(/different/i);
  });

  it('succeeds when every required criterion passes', () => {
    const state = replayGoalWorkflow(
      [
        start,
        stepEvent('step-1', 1, [passed('unit-tests'), passed('typecheck')]),
      ],
      { criteria, maxSteps: 3 },
    );

    expect(state).toMatchObject({ status: 'succeeded', currentStep: 1 });
    expect(state.latestResults['unit-tests']?.status).toBe('passed');
  });

  it('advances after an unsatisfied step', () => {
    const state = replayGoalWorkflow(
      [
        start,
        stepEvent('step-1', 1, [
          failed('unit-tests', 'failure-1'),
          passed('typecheck'),
        ]),
      ],
      { criteria, maxSteps: 3 },
    );

    expect(state).toMatchObject({ status: 'running', currentStep: 2 });
  });

  it('reports stuck after the same failure fingerprint occurs three times', () => {
    const repeatedFailure = (step: number) =>
      stepEvent(`step-${step}`, step, [
        failed('unit-tests', 'same-signed-failure'),
        passed('typecheck'),
      ]);
    const state = replayGoalWorkflow(
      [start, repeatedFailure(1), repeatedFailure(2), repeatedFailure(3)],
      { criteria, maxSteps: 3 },
    );

    expect(state).toMatchObject({
      status: 'failed',
      currentStep: 3,
      failureReason: 'stuck',
    });
  });

  it('reports step_limit after the third distinct failure', () => {
    const distinctFailure = (step: number) =>
      stepEvent(`step-${step}`, step, [
        failed('unit-tests', `failure-${step}`),
        passed('typecheck'),
      ]);
    const state = replayGoalWorkflow(
      [start, distinctFailure(1), distinctFailure(2), distinctFailure(3)],
      { criteria, maxSteps: 3 },
    );

    expect(state).toMatchObject({
      status: 'failed',
      currentStep: 3,
      failureReason: 'step_limit',
    });
  });

  it('fails closed on skipped steps or incomplete criterion results', () => {
    const running = reduceGoalWorkflow(
      createGoalWorkflow({ criteria, maxSteps: 3 }),
      start,
    );

    expect(() =>
      reduceGoalWorkflow(
        running,
        stepEvent('skipped', 2, [passed('unit-tests'), passed('typecheck')]),
      ),
    ).toThrow(/step/i);
    expect(() =>
      reduceGoalWorkflow(
        running,
        stepEvent('incomplete', 1, [passed('unit-tests')]),
      ),
    ).toThrow(/criterion/i);
  });
});
