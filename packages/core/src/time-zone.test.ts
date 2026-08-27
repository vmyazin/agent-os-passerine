import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  supportedTimeZones,
} from './time-zone.js';

describe('time zones', () => {
  it('accepts IANA zones and rejects malformed identifiers', () => {
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone(DEFAULT_TIME_ZONE)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });

  it('offers UTC alongside the runtime-supported selector values', () => {
    expect(supportedTimeZones()).toContain(DEFAULT_TIME_ZONE);
    expect(supportedTimeZones()).toContain('America/Sao_Paulo');
  });
});
