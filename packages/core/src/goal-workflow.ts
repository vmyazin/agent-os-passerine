import { createHash } from 'node:crypto';

import { canonicalJsonValue } from './config.js';
import {
  detectStuck,
  type CommandCriterion,
  type VerificationResult,
} from './dod.js';

const MAX_PROCESSED_EVENTS = 256;

export type GoalWorkflowStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface GoalWorkflowOptions {
  readonly criteria: readonly CommandCriterion[];
  readonly maxSteps: number;
}

export interface GoalWorkflowState {
  readonly status: GoalWorkflowStatus;
  readonly criteria: readonly Readonly<CommandCriterion>[];
  readonly maxSteps: number;
  readonly currentStep: number;
  readonly latestResults: Readonly<Record<string, VerificationResult>>;
  readonly failureFingerprints: readonly string[];
  readonly failureReason?: 'stuck' | 'step_limit' | 'crashed';
  readonly processedEventIds: readonly string[];
  readonly processedEventFingerprints: Readonly<Record<string, string>>;
}

export type GoalWorkflowEvent =
  | { readonly id: string; readonly type: 'start' }
  | {
      readonly id: string;
      readonly type: 'step_evaluated';
      readonly step: number;
      readonly results: readonly VerificationResult[];
    }
  | { readonly id: string; readonly type: 'cancel'; readonly reason?: string }
  | { readonly id: string; readonly type: 'crash'; readonly reason?: string };

function assertMaxSteps(maxSteps: number): void {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 3)
    throw new Error('Goal maxSteps must be an integer from 1 through 3');
}

function cloneAndFreezeCriteria(
  criteria: readonly CommandCriterion[],
): readonly Readonly<CommandCriterion>[] {
  if (criteria.length === 0)
    throw new Error('A goal requires at least one criterion');

  const ids = new Set<string>();
  const immutable = criteria.map((criterion) => {
    if (
      criterion.type !== 'command' ||
      criterion.id.trim().length === 0 ||
      criterion.description.trim().length === 0 ||
      criterion.command.trim().length === 0
    )
      throw new Error('Goal command criteria must be complete');
    if (ids.has(criterion.id))
      throw new Error(`Duplicate goal criterion id: ${criterion.id}`);
    ids.add(criterion.id);
    return Object.freeze({ ...criterion });
  });

  return Object.freeze(immutable);
}

export function createGoalWorkflow(
  options: GoalWorkflowOptions,
): GoalWorkflowState {
  assertMaxSteps(options.maxSteps);
  return {
    status: 'pending',
    criteria: cloneAndFreezeCriteria(options.criteria),
    maxSteps: options.maxSteps,
    currentStep: 0,
    latestResults: {},
    failureFingerprints: [],
    processedEventIds: [],
    processedEventFingerprints: {},
  };
}

function eventFingerprint(event: GoalWorkflowEvent): string {
  return createHash('sha256').update(canonicalJsonValue(event)).digest('hex');
}

function existingEventDisposition(
  state: GoalWorkflowState,
  event: GoalWorkflowEvent,
  fingerprint: string,
): 'new' | 'duplicate' {
  if (event.id.trim().length === 0)
    throw new Error('Goal workflow event id must not be empty');
  if (!Object.hasOwn(state.processedEventFingerprints, event.id)) return 'new';
  const existing = state.processedEventFingerprints[event.id];
  if (existing !== fingerprint)
    throw new Error(
      `Goal workflow event ${event.id} was replayed with different content`,
    );
  return 'duplicate';
}

function recordEvent(
  state: GoalWorkflowState,
  event: GoalWorkflowEvent,
  fingerprint: string,
  changes: Partial<GoalWorkflowState>,
): GoalWorkflowState {
  const retainedIds = [...state.processedEventIds, event.id].slice(
    -MAX_PROCESSED_EVENTS,
  );
  const retained = new Set(retainedIds);
  const processedEventFingerprints = Object.fromEntries(
    Object.entries({
      ...state.processedEventFingerprints,
      [event.id]: fingerprint,
    }).filter(([id]) => retained.has(id)),
  );
  return {
    ...state,
    ...changes,
    processedEventIds: retainedIds,
    processedEventFingerprints,
  };
}

function assertCompleteResults(
  state: GoalWorkflowState,
  results: readonly VerificationResult[],
): Readonly<Record<string, VerificationResult>> {
  if (results.length !== state.criteria.length)
    throw new Error(
      'A step must report exactly one result for every criterion',
    );

  const expectedIds = new Set(state.criteria.map((criterion) => criterion.id));
  const byCriterion: Record<string, VerificationResult> = {};
  for (const result of results) {
    if (!expectedIds.has(result.criterionId))
      throw new Error(`Unknown goal criterion result: ${result.criterionId}`);
    if (Object.hasOwn(byCriterion, result.criterionId))
      throw new Error(`Duplicate goal criterion result: ${result.criterionId}`);
    byCriterion[result.criterionId] = result;
  }
  if (Object.keys(byCriterion).length !== expectedIds.size)
    throw new Error(
      'A step must report exactly one result for every criterion',
    );
  return byCriterion;
}

const terminalStatuses = new Set<GoalWorkflowStatus>([
  'succeeded',
  'failed',
  'cancelled',
]);

export function reduceGoalWorkflow(
  state: GoalWorkflowState,
  event: GoalWorkflowEvent,
): GoalWorkflowState {
  const fingerprint = eventFingerprint(event);
  if (existingEventDisposition(state, event, fingerprint) === 'duplicate')
    return state;
  if (terminalStatuses.has(state.status))
    throw new Error(`Cannot transition terminal goal state ${state.status}`);

  if (event.type === 'start') {
    if (state.status !== 'pending')
      throw new Error(`Cannot start goal from ${state.status}`);
    return recordEvent(state, event, fingerprint, {
      status: 'running',
      currentStep: 1,
    });
  }

  if (event.type === 'cancel')
    return recordEvent(state, event, fingerprint, { status: 'cancelled' });

  if (event.type === 'crash')
    return recordEvent(state, event, fingerprint, {
      status: 'failed',
      failureReason: 'crashed',
    });

  if (state.status !== 'running')
    throw new Error(`Cannot evaluate a goal step from ${state.status}`);
  if (event.step !== state.currentStep)
    throw new Error(
      `Expected goal step ${state.currentStep}, received ${event.step}`,
    );

  const stepResults = assertCompleteResults(state, event.results);
  const latestResults = { ...state.latestResults, ...stepResults };
  const allRequiredPassed = state.criteria
    .filter((criterion) => criterion.required !== false)
    .every((criterion) => latestResults[criterion.id]?.status === 'passed');
  if (allRequiredPassed)
    return recordEvent(state, event, fingerprint, {
      status: 'succeeded',
      latestResults,
    });

  const failureFingerprints = [
    ...state.failureFingerprints,
    ...event.results.flatMap((result) =>
      result.status === 'failed' ? [result.fingerprint] : [],
    ),
  ];
  if (detectStuck(failureFingerprints).stuck)
    return recordEvent(state, event, fingerprint, {
      status: 'failed',
      latestResults,
      failureFingerprints,
      failureReason: 'stuck',
    });
  if (state.currentStep >= state.maxSteps)
    return recordEvent(state, event, fingerprint, {
      status: 'failed',
      latestResults,
      failureFingerprints,
      failureReason: 'step_limit',
    });

  return recordEvent(state, event, fingerprint, {
    latestResults,
    failureFingerprints,
    currentStep: state.currentStep + 1,
  });
}

export function replayGoalWorkflow(
  events: readonly GoalWorkflowEvent[],
  options: GoalWorkflowOptions,
): GoalWorkflowState {
  return events.reduce(reduceGoalWorkflow, createGoalWorkflow(options));
}
