export const DEFAULT_TIME_ZONE = 'UTC';

/** Validate an IANA timezone identifier using the runtime's canonical data. */
export function isValidTimeZone(value: string): boolean {
  if (value.trim() === '' || value.length > 255) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function supportedTimeZones(): readonly string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes(DEFAULT_TIME_ZONE)
    ? zones
    : [DEFAULT_TIME_ZONE, ...zones];
}
