import { describe, expect, it } from 'vitest';

import {
  createFeatureWorkflow,
  reduceFeatureWorkflow,
  replayFeatureWorkflow,
  type FeatureWorkflowEvent,
} from './feature-workflow.js';

const event = (
  id: string,
  type: FeatureWorkflowEvent['type'],
): FeatureWorkflowEvent => ({ id, type }) as FeatureWorkflowEvent;

const happyPath: FeatureWorkflowEvent[] = [
  event('1', 'specification_completed'),
  event('2', 'specification_approved'),
  event('3', 'plan_completed'),
  event('4', 'implementation_completed'),
  event('5', 'tests_passed'),
  event('6', 'review_passed'),
  event('7', 'policy_passed'),
  {
    id: '8',
    type: 'draft_published',
    publication: { id: 'pr-1', url: 'https://example.test/pr/1', draft: true },
  },
];

describe('feature workflow reducer', () => {
  it('runs specification through policy validation to draft publication', () => {
    const completed = replayFeatureWorkflow(happyPath, { maxRetries: 2 });

    expect(completed).toMatchObject({
      status: 'succeeded',
      phase: 'draft_publication',
    });
    expect(completed.publication?.draft).toBe(true);
  });

  it('fails when combined specification and DoD approval is rejected', () => {
    const rejected = replayFeatureWorkflow(
      [
        event('1', 'specification_completed'),
        {
          id: '2',
          type: 'specification_rejected',
          reason: 'DoD is incomplete',
        },
      ],
      { maxRetries: 2 },
    );

    expect(rejected).toMatchObject({
      status: 'failed',
      failureReason: 'DoD is incomplete',
    });
  });

  it('routes test, review, and policy failures through fixes and enforces retry limit', () => {
    let state = replayFeatureWorkflow(happyPath.slice(0, 4), { maxRetries: 1 });
    state = reduceFeatureWorkflow(state, event('failure-1', 'tests_failed'));
    expect(state.phase).toBe('fixing');
    state = reduceFeatureWorkflow(state, event('fix-1', 'fix_completed'));
    state = reduceFeatureWorkflow(state, event('failure-2', 'tests_failed'));

    expect(state).toMatchObject({
      status: 'failed',
      retryCount: 2,
      failureReason: 'retry_limit',
    });
  });

  it.each([
    ['cancel', 'cancelled'],
    ['exhaust_budget', 'budget_exhausted'],
  ] as const)('handles %s from an active phase', (type, status) => {
    expect(
      reduceFeatureWorkflow(
        createFeatureWorkflow({ maxRetries: 2 }),
        event('1', type),
      ).status,
    ).toBe(status);
  });

  it('supports crash/resume replay and ignores duplicate event IDs', () => {
    const events: FeatureWorkflowEvent[] = [
      event('1', 'specification_completed'),
      event('2', 'specification_approved'),
      event('3', 'crashed'),
      event('4', 'resume'),
      event('5', 'plan_completed'),
    ];
    const replayed = replayFeatureWorkflow(events, { maxRetries: 2 });
    const duplicated = replayFeatureWorkflow([...events, ...events], {
      maxRetries: 2,
    });

    expect(replayed).toMatchObject({
      status: 'running',
      phase: 'implementation',
      retryCount: 1,
    });
    expect(duplicated).toEqual(replayed);
    expect(reduceFeatureWorkflow(replayed, event('5', 'cancel'))).toBe(
      replayed,
    );
  });

  it('supports review/fix loops before policy validation', () => {
    const reviewed = replayFeatureWorkflow(
      [
        ...happyPath.slice(0, 5),
        event('review-1', 'review_changes_requested'),
        event('fix-1', 'fix_completed'),
        event('test-2', 'tests_passed'),
        event('review-2', 'review_passed'),
      ],
      { maxRetries: 2 },
    );

    expect(reviewed).toMatchObject({
      phase: 'policy_validation',
      status: 'running',
      retryCount: 1,
    });
  });
});
