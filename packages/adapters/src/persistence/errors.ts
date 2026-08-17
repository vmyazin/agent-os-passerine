export class EventFingerprintConflictError extends Error {
  public constructor(runId: string, eventId: string) {
    super(
      `Event ${eventId} for run ${runId} already has a different fingerprint`,
    );
    this.name = 'EventFingerprintConflictError';
  }
}

export class EventSequenceConflictError extends Error {
  public constructor(runId: string, sequence: number) {
    super(`Event sequence ${sequence} for run ${runId} already exists`);
    this.name = 'EventSequenceConflictError';
  }
}

export class IdempotencyConflictError extends Error {
  public constructor(kind: string, id: string) {
    super(`${kind} ${id} already exists with different content`);
    this.name = 'IdempotencyConflictError';
  }
}

export class StaleConfigurationError extends Error {
  public constructor() {
    super('Active configuration changed before apply');
    this.name = 'StaleConfigurationError';
  }
}
