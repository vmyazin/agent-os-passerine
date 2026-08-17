import type { JsonValue } from '@agentos/core';

import type {
  WorkflowCheckpointStore,
  WorkflowEffect,
  WorkflowSessionAdmission,
} from './types.js';

const copy = <T>(value: T): T => structuredClone(value);

export class WorkflowCheckpointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowCheckpointConflictError';
  }
}

export class InMemoryWorkflowCheckpointStore implements WorkflowCheckpointStore {
  readonly #effects = new Map<string, WorkflowEffect>();
  #session:
    { runId: string; stepKey: string; leaseExpiresAt: string } | undefined;

  async claimEffect(
    draft: Omit<WorkflowEffect, 'status'>,
  ): Promise<WorkflowEffect> {
    const existing = this.#effects.get(draft.key);
    if (existing !== undefined) {
      if (
        existing.runId !== draft.runId ||
        existing.kind !== draft.kind ||
        existing.inputFingerprint !== draft.inputFingerprint
      ) {
        throw new WorkflowCheckpointConflictError(
          `workflow effect ${draft.key} was replayed with different input`,
        );
      }
      return copy(existing);
    }
    const effect: WorkflowEffect = { ...draft, status: 'pending' };
    this.#effects.set(effect.key, copy(effect));
    return copy(effect);
  }

  async markEffectStarted(key: string, now: string): Promise<WorkflowEffect> {
    const effect = this.#require(key);
    if (effect.status !== 'pending') return copy(effect);
    return this.#set({ ...effect, status: 'started', updatedAt: now });
  }

  async attachExternalRef(
    key: string,
    externalRef: string,
    now: string,
  ): Promise<WorkflowEffect> {
    const effect = this.#require(key);
    if (effect.status !== 'started') {
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${key} is not started`,
      );
    }
    if (
      effect.externalRef !== undefined &&
      effect.externalRef !== externalRef
    ) {
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${key} has a different external reference`,
      );
    }
    return this.#set({ ...effect, externalRef, updatedAt: now });
  }

  async completeEffect(
    key: string,
    output: JsonValue,
    now: string,
  ): Promise<WorkflowEffect> {
    const effect = this.#require(key);
    if (effect.status === 'succeeded') {
      if (JSON.stringify(effect.output) !== JSON.stringify(output)) {
        throw new WorkflowCheckpointConflictError(
          `workflow effect ${key} has different output`,
        );
      }
      return copy(effect);
    }
    if (effect.status !== 'started') {
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${key} is not started`,
      );
    }
    return this.#set({
      ...effect,
      status: 'succeeded',
      output,
      updatedAt: now,
    });
  }

  async failEffect(
    key: string,
    error: string,
    deadLetter: boolean,
    now: string,
  ): Promise<WorkflowEffect> {
    const effect = this.#require(key);
    if (effect.status === 'succeeded') return copy(effect);
    return this.#set({
      ...effect,
      status: deadLetter ? 'dead_letter' : 'failed',
      error: error.slice(0, 1_000),
      updatedAt: now,
    });
  }

  async getEffect(key: string): Promise<WorkflowEffect | undefined> {
    const effect = this.#effects.get(key);
    return effect === undefined ? undefined : copy(effect);
  }

  async listEffects(runId: string): Promise<readonly WorkflowEffect[]> {
    return [...this.#effects.values()]
      .filter((effect) => effect.runId === runId)
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(copy);
  }

  async admitSession(request: WorkflowSessionAdmission): Promise<
    | { readonly admitted: true }
    | {
        readonly admitted: false;
        readonly reason: 'workflow_budget' | 'daily_budget' | 'concurrency';
      }
  > {
    const workflowThreshold = Math.floor(
      (request.workflowLimitMicrodollars * request.admissionNumerator) /
        request.admissionDenominator,
    );
    const dailyThreshold = Math.floor(
      (request.dailyLimitMicrodollars * request.admissionNumerator) /
        request.admissionDenominator,
    );
    if (request.workflowSpentMicrodollars >= workflowThreshold)
      return { admitted: false, reason: 'workflow_budget' };
    if (request.dailySpentMicrodollars >= dailyThreshold)
      return { admitted: false, reason: 'daily_budget' };
    if (
      this.#session !== undefined &&
      this.#session.leaseExpiresAt > request.now &&
      (this.#session.runId !== request.runId ||
        this.#session.stepKey !== request.stepKey)
    ) {
      return { admitted: false, reason: 'concurrency' };
    }
    this.#session = {
      runId: request.runId,
      stepKey: request.stepKey,
      leaseExpiresAt: request.leaseExpiresAt,
    };
    return { admitted: true };
  }

  async releaseSession(runId: string, stepKey: string): Promise<void> {
    if (this.#session?.runId === runId && this.#session.stepKey === stepKey) {
      this.#session = undefined;
    }
  }

  #require(key: string): WorkflowEffect {
    const effect = this.#effects.get(key);
    if (effect === undefined)
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${key} does not exist`,
      );
    return effect;
  }

  #set(effect: WorkflowEffect): WorkflowEffect {
    this.#effects.set(effect.key, copy(effect));
    return copy(effect);
  }
}
