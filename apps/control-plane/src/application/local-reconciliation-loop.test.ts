import { describe, expect, it, vi } from 'vitest';

import { startLocalReconciliationLoop } from './local-reconciliation-loop';

/** Drives the loop's timers by hand so no test waits on a real clock. */
function harness() {
  let delayed: (() => void) | undefined;
  let ticked: (() => void) | undefined;
  const loopOptions = {
    firstDelayMs: 10,
    intervalMs: 20,
    setDelay: ((fn: () => void) => {
      delayed = fn;
      return { unref: () => {} } as never;
    }) as never,
    setTimer: ((fn: () => void) => {
      ticked = fn;
      return { unref: () => {} } as never;
    }) as never,
    clearDelay: (() => {}) as never,
    clearTimer: (() => {}) as never,
  };
  return {
    loopOptions,
    firstSweep: () => delayed?.(),
    tick: () => ticked?.(),
  };
}

describe('local reconciliation loop', () => {
  it('does not sweep before the startup delay elapses', () => {
    const run = vi.fn().mockResolvedValue({});
    const { loopOptions } = harness();
    startLocalReconciliationLoop({ ...loopOptions, run });
    expect(run).not.toHaveBeenCalled();
  });

  it('sweeps once the delay elapses and again on every interval', async () => {
    const run = vi.fn().mockResolvedValue({});
    const h = harness();
    startLocalReconciliationLoop({ ...h.loopOptions, run });
    h.firstSweep();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    h.tick();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('skips a turn rather than overlapping a sweep that is still running', async () => {
    let release: (() => void) | undefined;
    const run = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const h = harness();
    startLocalReconciliationLoop({ ...h.loopOptions, run });
    h.firstSweep();
    await Promise.resolve();
    h.tick();
    h.tick();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    h.tick();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports a failing sweep once instead of on every interval', async () => {
    const run = vi.fn().mockRejectedValue(new Error('dispatch not configured'));
    const log = vi.fn();
    const h = harness();
    startLocalReconciliationLoop({ ...h.loopOptions, run, log });
    h.firstSweep();
    await Promise.resolve();
    await Promise.resolve();
    h.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('dispatch not configured');
  });

  it('keeps a failing sweep from taking the dev server down', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const h = harness();
    expect(() =>
      startLocalReconciliationLoop({ ...h.loopOptions, run, log: () => {} }),
    ).not.toThrow();
    expect(() => h.firstSweep()).not.toThrow();
    await Promise.resolve();
  });
});
