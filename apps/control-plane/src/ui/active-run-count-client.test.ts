import { describe, expect, it, vi } from 'vitest';

import {
  activeRunPresentation,
  fetchActiveRunCount,
  formatActiveRunCount,
  subscribeToActiveRunCount,
} from './active-run-count-client';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('active run presentation', () => {
  it('hides zero, caps only the badge, and keeps the exact accessible count', () => {
    expect(activeRunPresentation(0)).toBeUndefined();
    expect(formatActiveRunCount(1)).toBe('1');
    expect(formatActiveRunCount(99)).toBe('99');
    expect(formatActiveRunCount(100)).toBe('99+');
    expect(activeRunPresentation(1)).toEqual({
      badgeText: '1',
      ariaLabel: 'Runs, 1 active run',
    });
    expect(activeRunPresentation(143)).toEqual({
      badgeText: '99+',
      ariaLabel: 'Runs, 143 active runs',
    });
  });
});

describe('fetchActiveRunCount', () => {
  it('accepts only a successful nonnegative safe integer payload', async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn(async () => response({ count: 4 }));

    await expect(fetchActiveRunCount(signal, fetcher)).resolves.toBe(4);
    expect(fetcher).toHaveBeenCalledWith('/api/runs/active-count', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    });

    for (const [body, status] of [
      [{ count: 4 }, 503],
      [{ count: -1 }, 200],
      [{ count: 1.5 }, 200],
      [{ count: Number.MAX_SAFE_INTEGER + 1 }, 200],
      [{ count: 1, extra: true }, 200],
      [{ total: 1 }, 200],
    ] as const) {
      await expect(
        fetchActiveRunCount(
          signal,
          vi.fn(async () => response(body, status)),
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('fails soft when the request or JSON parsing fails', async () => {
    const signal = new AbortController().signal;
    await expect(
      fetchActiveRunCount(
        signal,
        vi.fn(async () => {
          throw new Error('offline');
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      fetchActiveRunCount(
        signal,
        vi.fn(async () => new Response('{', { status: 200 })),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('subscribeToActiveRunCount', () => {
  it('refreshes initially, on its interval, focus, and visibility restoration', async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    let visible = true;
    let intervalCallback: (() => void) | undefined;
    const clearIntervalFn = vi.fn();
    const fetchCount = vi.fn(async () => 2);
    const listener = vi.fn();

    const unsubscribe = subscribeToActiveRunCount(listener, {
      windowTarget,
      documentTarget,
      isVisible: () => visible,
      fetchCount,
      setIntervalFn(callback, delay) {
        expect(delay).toBe(10_000);
        intervalCallback = callback;
        return 'interval';
      },
      clearIntervalFn,
    });

    await vi.waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(1));
    expect(listener).toHaveBeenLastCalledWith(2);

    intervalCallback?.();
    await vi.waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(2));

    visible = false;
    intervalCallback?.();
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(fetchCount).toHaveBeenCalledTimes(2);

    visible = true;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(3));
    windowTarget.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(4));

    unsubscribe();
    expect(clearIntervalFn).toHaveBeenCalledWith('interval');
  });
});
