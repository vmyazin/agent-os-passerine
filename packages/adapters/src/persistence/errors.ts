export class EventFingerprintConflictError extends Error {
  public constructor(runId: string, eventId: string) {
    super(
      `Event ${eventId} for run ${runId} already has a different fingerprint`,
    );
    this.name = 'EventFingerprintConflictError';
  }
}

export class IdempotencyConflictError extends Error {
  public constructor(kind: string, id: string) {
    super(`${kind} ${id} already exists with different content`);
    this.name = 'IdempotencyConflictError';
  }
}
