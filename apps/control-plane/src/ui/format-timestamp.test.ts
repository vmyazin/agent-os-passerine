import { describe, expect, it } from 'vitest';

import {
  formatDisplayDate,
  formatDisplayDateTime,
  formatDisplayTime,
} from './format-timestamp';

describe('timezone-aware timestamp formatting', () => {
  const instant = '2026-08-27T01:00:00.000Z';

  it('uses the selected timezone when the local calendar date differs', () => {
    expect(formatDisplayDate(instant, 'UTC')).toBe('Aug 27, 2026');
    expect(formatDisplayDate(instant, 'America/Sao_Paulo')).toBe(
      'Aug 26, 2026',
    );
  });

  it('labels absolute date-times and clocks with the selected zone', () => {
    expect(formatDisplayDateTime(instant, 'America/Sao_Paulo')).toContain(
      'Aug 26, 2026',
    );
    expect(formatDisplayDateTime(instant, 'America/Sao_Paulo')).toContain(
      'GMT-3',
    );
    expect(formatDisplayTime(instant, 'UTC')).toBe('01:00:00 UTC');
  });

  it('preserves malformed values for diagnosis', () => {
    expect(formatDisplayDateTime('not-a-timestamp', 'UTC')).toBe(
      'not-a-timestamp',
    );
  });
});
