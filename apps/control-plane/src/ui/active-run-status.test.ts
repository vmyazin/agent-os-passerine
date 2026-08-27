import { describe, expect, it } from 'vitest';

import { ACTIVE_RUN_STATUSES, isRunActive } from './active-run-status';

describe('active run status', () => {
  it('counts only statuses where execution is moving', () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(['pending', 'running']);
    expect(isRunActive('pending')).toBe(true);
    expect(isRunActive('running')).toBe(true);
    expect(isRunActive('waiting')).toBe(false);
    expect(isRunActive('succeeded')).toBe(false);
    expect(isRunActive('failed')).toBe(false);
    expect(isRunActive('cancelled')).toBe(false);
  });
});
