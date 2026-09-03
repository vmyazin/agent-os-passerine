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

  it('renders in the selected zone without naming it', () => {
    // The zone is a setting the operator chose, so it is true of every
    // timestamp on the page; printing it on each one crowds out the time.
    // The conversion still has to happen, which is what the dates prove.
    const sao = formatDisplayDateTime(instant, 'America/Sao_Paulo');
    expect(sao).toContain('Aug 26, 2026');
    expect(sao).not.toMatch(/GMT|UTC/);
    expect(formatDisplayDateTime(instant, 'UTC')).toContain('Aug 27, 2026');
    expect(formatDisplayTime(instant, 'UTC')).toBe('01:00:00');
    expect(formatDisplayTime(instant, 'America/Sao_Paulo')).toBe('22:00:00');
  });

  it('preserves malformed values for diagnosis', () => {
    expect(formatDisplayDateTime('not-a-timestamp', 'UTC')).toBe(
      'not-a-timestamp',
    );
  });
});
