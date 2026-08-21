import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  publishProjectCount,
  subscribeToProjectCount,
} from './project-count-signal';

// The signal only needs an event target, so the suite installs a bare one
// rather than pulling a DOM implementation into a repo whose tests are
// otherwise pure logic.
const globals = globalThis as { window?: unknown };

beforeEach(() => {
  globals.window = new EventTarget();
});

afterEach(() => {
  delete globals.window;
});

describe('project count signal', () => {
  it('delivers a published count to subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToProjectCount(listener);
    publishProjectCount(3);
    expect(listener).toHaveBeenCalledWith(3);
    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn();
    subscribeToProjectCount(listener)();
    publishProjectCount(4);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a payload that is not a usable count', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToProjectCount(listener);
    for (const detail of ['2', -1, Number.NaN, undefined, {}])
      (globals.window as EventTarget).dispatchEvent(
        new CustomEvent('agentos:project-count', { detail }),
      );
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('is inert on the server, where there is no window', () => {
    delete globals.window;
    const listener = vi.fn();
    expect(() => subscribeToProjectCount(listener)()).not.toThrow();
    expect(() => publishProjectCount(1)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});
