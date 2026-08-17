import { createHash } from 'node:crypto';

export const EVENT_DEDUPE_WINDOW = 256;

export interface EventDedupeState {
  readonly processedEventIds: readonly string[];
  readonly processedEventFingerprints?: Readonly<Record<string, string>>;
}

export function assertValidEventId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error(
      'Event ID must be non-empty and contain only safe identifier characters',
    );
  }
}

function canonicalizeEventValue(value: unknown): unknown {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error('Invalid event timestamp');
    return { $date: value.toISOString() };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Event numbers must be finite');
  }
  if (Array.isArray(value)) return value.map(canonicalizeEventValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalizeEventValue(entry)]),
    );
  }
  return value;
}

export function eventFingerprint(event: { readonly id: string }): string {
  assertValidEventId(event.id);
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeEventValue(event)))
    .digest('hex');
}

export function isDuplicateEvent(
  state: EventDedupeState,
  event: { readonly id: string },
): boolean {
  const fingerprint = eventFingerprint(event);
  const fingerprintRecord = state.processedEventFingerprints;
  const known =
    fingerprintRecord !== undefined &&
    Object.prototype.hasOwnProperty.call(fingerprintRecord, event.id)
      ? fingerprintRecord[event.id]
      : undefined;
  if (known !== undefined) {
    if (known !== fingerprint) {
      throw new Error(
        `Event ID ${event.id} was reused with different type or payload`,
      );
    }
    return true;
  }
  return state.processedEventIds.includes(event.id);
}

export function recordProcessedEvent(
  state: EventDedupeState,
  event: { readonly id: string },
): Pick<EventDedupeState, 'processedEventIds' | 'processedEventFingerprints'> {
  const fingerprint = eventFingerprint(event);
  const ids = [...state.processedEventIds, event.id];
  const fingerprints: Record<string, string> = {
    ...state.processedEventFingerprints,
    [event.id]: fingerprint,
  };
  while (ids.length > EVENT_DEDUPE_WINDOW) {
    const expiredId = ids.shift();
    if (expiredId !== undefined) delete fingerprints[expiredId];
  }
  return {
    processedEventIds: Object.freeze(ids),
    processedEventFingerprints: Object.freeze(fingerprints),
  };
}
