// src/ui/time-of-day-greeting.test.ts
import { describe, expect, it } from 'vitest';

import { timeOfDayGreeting } from './time-of-day-greeting';

describe('timeOfDayGreeting', () => {
  it('uses the selected timezone during daylight saving time', () => {
    const zone = 'America/New_York';
    expect(timeOfDayGreeting(new Date('2026-08-20T08:59:00.000Z'), zone)).toBe(
      'Good evening',
    );
    expect(timeOfDayGreeting(new Date('2026-08-20T09:00:00.000Z'), zone)).toBe(
      'Good morning',
    );
    expect(timeOfDayGreeting(new Date('2026-08-20T15:59:00.000Z'), zone)).toBe(
      'Good morning',
    );
    expect(timeOfDayGreeting(new Date('2026-08-20T16:00:00.000Z'), zone)).toBe(
      'Good afternoon',
    );
    expect(timeOfDayGreeting(new Date('2026-08-20T20:59:00.000Z'), zone)).toBe(
      'Good afternoon',
    );
    expect(timeOfDayGreeting(new Date('2026-08-20T21:00:00.000Z'), zone)).toBe(
      'Good evening',
    );
  });

  it('uses the selected timezone during standard time', () => {
    const zone = 'America/New_York';
    expect(timeOfDayGreeting(new Date('2026-01-15T09:59:00.000Z'), zone)).toBe(
      'Good evening',
    );
    expect(timeOfDayGreeting(new Date('2026-01-15T10:00:00.000Z'), zone)).toBe(
      'Good morning',
    );
    expect(timeOfDayGreeting(new Date('2026-01-15T16:59:00.000Z'), zone)).toBe(
      'Good morning',
    );
    expect(timeOfDayGreeting(new Date('2026-01-15T17:00:00.000Z'), zone)).toBe(
      'Good afternoon',
    );
    expect(timeOfDayGreeting(new Date('2026-01-15T21:59:00.000Z'), zone)).toBe(
      'Good afternoon',
    );
    expect(timeOfDayGreeting(new Date('2026-01-15T22:00:00.000Z'), zone)).toBe(
      'Good evening',
    );
  });

  it('changes the greeting when operators occupy different zones', () => {
    const instant = new Date('2026-08-20T10:00:00.000Z');
    expect(timeOfDayGreeting(instant, 'Pacific/Honolulu')).toBe('Good evening');
    expect(timeOfDayGreeting(instant, 'Europe/Helsinki')).toBe(
      'Good afternoon',
    );
  });
});
