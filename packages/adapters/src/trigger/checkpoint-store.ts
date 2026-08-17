import type { JsonValue } from '@agentos/core';

import type {
  WorkflowCheckpointStore,
  WorkflowEffect,
  WorkflowEffectClaim,
  WorkflowEffectLease,
  WorkflowSessionAdmission,
  WorkflowSessionSettlement,
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
  readonly #reservations = new Map<
    string,
    {
      runId: string;
      projectId: string;
      stepKey: string;
      estimatedMicrodollars: number;
      expiresAt: string;
    }
  >();

  async claimEffect(
    draft: Omit<
      WorkflowEffect,
      'status' | 'ownerId' | 'leaseVersion' | 'leaseExpiresAt'
    >,
    claim: WorkflowEffectClaim,
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
      if (
        existing.status !== 'succeeded' &&
        (existing.ownerId === claim.ownerId ||
          existing.leaseExpiresAt === undefined ||
          existing.leaseExpiresAt <= claim.now)
      ) {
        return this.#set({
          ...existing,
          ownerId: claim.ownerId,
          leaseVersion:
            existing.ownerId === claim.ownerId
              ? existing.leaseVersion
              : existing.leaseVersion + 1,
          leaseExpiresAt: claim.leaseExpiresAt,
          updatedAt: claim.now,
        });
      }
      return copy(existing);
    }
    const effect: WorkflowEffect = {
      ...draft,
      status: 'pending',
      ownerId: claim.ownerId,
      leaseVersion: 1,
      leaseExpiresAt: claim.leaseExpiresAt,
    };
    this.#effects.set(effect.key, copy(effect));
    return copy(effect);
  }

  async markEffectStarted(
    lease: WorkflowEffectLease,
    now: string,
  ): Promise<WorkflowEffect> {
    const effect = this.#owned(lease);
    if (effect.status !== 'pending' && effect.status !== 'failed')
      return copy(effect);
    return this.#set({ ...effect, status: 'started', updatedAt: now });
  }

  async attachExternalRef(
    lease: WorkflowEffectLease,
    externalRef: string,
    now: string,
  ): Promise<WorkflowEffect> {
    const effect = this.#owned(lease);
    if (effect.status !== 'started') {
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${lease.key} is not started`,
      );
    }
    if (
      effect.externalRef !== undefined &&
      effect.externalRef !== externalRef
    ) {
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${lease.key} has a different external reference`,
      );
    }
    return this.#set({ ...effect, externalRef, updatedAt: now });
  }

  async completeEffect(
    lease: WorkflowEffectLease,
    output: JsonValue,
    now: string,
  ): Promise<WorkflowEffect> {
    const effect = this.#owned(lease);
    if (effect.status === 'succeeded') {
      if (JSON.stringify(effect.output) !== JSON.stringify(output)) {
        throw new WorkflowCheckpointConflictError(
          `workflow effect ${lease.key} has different output`,
        );
      }
      return copy(effect);
    }
    if (effect.status !== 'started') {
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${lease.key} is not started`,
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
    lease: WorkflowEffectLease,
    error: string,
    deadLetter: boolean,
    now: string,
  ): Promise<WorkflowEffect> {
    const effect = this.#owned(lease);
    if (effect.status === 'succeeded') return copy(effect);
    return this.#set({
      ...effect,
      status: deadLetter ? 'dead_letter' : 'failed',
      error: error.slice(0, 1_000),
      updatedAt: now,
    });
  }

  async renewEffect(
    lease: WorkflowEffectLease,
    now: string,
    leaseExpiresAt: string,
  ): Promise<WorkflowEffect> {
    const effect = this.#owned(lease);
    return this.#set({ ...effect, leaseExpiresAt, updatedAt: now });
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
    const existingReservation = this.#reservations.get(request.reservationKey);
    if (existingReservation !== undefined) {
      if (
        existingReservation.runId !== request.runId ||
        existingReservation.projectId !== request.projectId ||
        existingReservation.stepKey !== request.stepKey ||
        existingReservation.estimatedMicrodollars !==
          request.estimatedMicrodollars
      ) {
        throw new WorkflowCheckpointConflictError(
          `workflow reservation ${request.reservationKey} conflicts`,
        );
      }
      if (
        this.#session !== undefined &&
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
    const workflowReserved = [...this.#reservations.values()]
      .filter((reservation) => reservation.runId === request.runId)
      .reduce((sum, reservation) => sum + reservation.estimatedMicrodollars, 0);
    const dailyReserved = [...this.#reservations.values()]
      .filter((reservation) => reservation.projectId === request.projectId)
      .reduce((sum, reservation) => sum + reservation.estimatedMicrodollars, 0);
    const workflowThreshold = Math.floor(
      (request.workflowLimitMicrodollars * request.admissionNumerator) /
        request.admissionDenominator,
    );
    const dailyThreshold = Math.floor(
      (request.dailyLimitMicrodollars * request.admissionNumerator) /
        request.admissionDenominator,
    );
    if (
      request.workflowSpentMicrodollars +
        workflowReserved +
        request.estimatedMicrodollars >=
        workflowThreshold ||
      request.workflowSpentMicrodollars +
        workflowReserved +
        request.estimatedMicrodollars >
        request.workflowLimitMicrodollars
    )
      return { admitted: false, reason: 'workflow_budget' };
    if (
      request.dailySpentMicrodollars +
        dailyReserved +
        request.estimatedMicrodollars >=
        dailyThreshold ||
      request.dailySpentMicrodollars +
        dailyReserved +
        request.estimatedMicrodollars >
        request.dailyLimitMicrodollars
    )
      return { admitted: false, reason: 'daily_budget' };
    if (
      this.#session !== undefined &&
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
    this.#reservations.set(request.reservationKey, {
      runId: request.runId,
      projectId: request.projectId,
      stepKey: request.stepKey,
      estimatedMicrodollars: request.estimatedMicrodollars,
      expiresAt: request.leaseExpiresAt,
    });
    return { admitted: true };
  }

  async settleSession(request: WorkflowSessionSettlement): Promise<
    | { readonly settled: true }
    | {
        readonly settled: false;
        readonly reason: 'workflow_budget' | 'daily_budget';
      }
  > {
    const reservation = this.#reservations.get(request.reservationKey);
    if (reservation === undefined) return { settled: true };
    if (
      reservation.runId !== request.runId ||
      reservation.stepKey !== request.stepKey ||
      !Number.isSafeInteger(request.actualMicrodollars) ||
      request.actualMicrodollars < 0
    ) {
      throw new WorkflowCheckpointConflictError(
        `workflow reservation ${request.reservationKey} cannot be settled`,
      );
    }
    this.#reservations.delete(request.reservationKey);
    if (request.workflowSpentMicrodollars > request.workflowLimitMicrodollars)
      return { settled: false, reason: 'workflow_budget' };
    if (request.dailySpentMicrodollars > request.dailyLimitMicrodollars)
      return { settled: false, reason: 'daily_budget' };
    return { settled: true };
  }

  async releaseSession(runId: string, stepKey: string): Promise<void> {
    if (this.#session?.runId === runId && this.#session.stepKey === stepKey) {
      this.#session = undefined;
    }
  }

  async listExpiredReservations(runId: string, now: string) {
    return [...this.#reservations.entries()]
      .filter(
        ([, reservation]) =>
          reservation.runId === runId && reservation.expiresAt <= now,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reservationKey, reservation]) => ({
        reservationKey,
        ...reservation,
      }));
  }

  #require(key: string): WorkflowEffect {
    const effect = this.#effects.get(key);
    if (effect === undefined)
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${key} does not exist`,
      );
    return effect;
  }

  #owned(lease: WorkflowEffectLease): WorkflowEffect {
    const effect = this.#require(lease.key);
    if (
      effect.ownerId !== lease.ownerId ||
      effect.leaseVersion !== lease.leaseVersion
    ) {
      throw new WorkflowCheckpointConflictError(
        `workflow effect ${lease.key} fencing lease is not owned`,
      );
    }
    return effect;
  }

  #set(effect: WorkflowEffect): WorkflowEffect {
    this.#effects.set(effect.key, copy(effect));
    return copy(effect);
  }
}
