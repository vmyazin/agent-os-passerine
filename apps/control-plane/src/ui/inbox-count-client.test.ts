import { describe, expect, it, vi } from 'vitest';

import {
  fetchInboxAttentionCount,
  formatInboxAttentionCount,
  INBOX_ATTENTION_CHANGED_EVENT,
  inboxAttentionAriaLabel,
  inboxAttentionPresentation,
  subscribeToInboxAttentionChanged,
  subscribeToInboxAttentionCount,
} from './inbox-count-client';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('inbox count presentation', () => {
  it('hides zero, caps only the badge, and keeps the true accessible count', () => {
    expect(inboxAttentionPresentation(0)).toBeUndefined();
    expect(formatInboxAttentionCount(1)).toBe('1');
    expect(formatInboxAttentionCount(99)).toBe('99');
    expect(formatInboxAttentionCount(100)).toBe('99+');
    expect(inboxAttentionAriaLabel(1)).toBe(
      'Inbox, 1 item needs attention',
    );
    expect(inboxAttentionPresentation(143)).toEqual({
      badgeText: '99+',
      ariaLabel: 'Inbox, 143 items need attention',
    });
  });
});

describe('fetchInboxAttentionCount', () => {
  it('accepts only a successful nonnegative safe integer payload', async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn(async () => response({ count: 4 }));
    await expect(
      fetchInboxAttentionCount(signal, fetcher),
    ).resolves.toBe(4);
    expect(fetcher).toHaveBeenCalledWith('/api/inbox/count', {
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
        fetchInboxAttentionCount(
          signal,
          vi.fn(async () => response(body, status)),
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('fails soft when the request or JSON parsing fails', async () => {
    const signal = new AbortController().signal;
    await expect(
      fetchInboxAttentionCount(
        signal,
        vi.fn(async () => {
          throw new Error('offline');
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      fetchInboxAttentionCount(
        signal,
        vi.fn(async () => new Response('{', { status: 200 })),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('subscribeToInboxAttentionCount', () => {
  it('refreshes initially, while visible, on focus, restoration, and mutations', async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    let visible = true;
    let intervalCallback: (() => void) | undefined;
    const clearIntervalFn = vi.fn();
    const fetchCount = vi.fn(async () => 3);
    const listener = vi.fn();

    const unsubscribe = subscribeToInboxAttentionCount(listener, {
      windowTarget,
      documentTarget,
      isVisible: () => visible,
      fetchCount,
      setIntervalFn(callback, delay) {
        expect(delay).toBe(15_000);
        intervalCallback = callback;
        return 'interval';
      },
      clearIntervalFn,
    });

    await vi.waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(1));
    expect(listener).toHaveBeenLastCalledWith(3);

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
    windowTarget.dispatchEvent(new Event(INBOX_ATTENTION_CHANGED_EVENT));
    await vi.waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(5));

    unsubscribe();
    expect(clearIntervalFn).toHaveBeenCalledWith('interval');
    windowTarget.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(fetchCount).toHaveBeenCalledTimes(5);
  });

  it('serializes overlapping refreshes and performs one trailing refresh', async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const resolvers: Array<(count: number | undefined) => void> = [];
    const fetchCount = vi.fn(
      () =>
        new Promise<number | undefined>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const listener = vi.fn();
    const unsubscribe = subscribeToInboxAttentionCount(listener, {
      windowTarget,
      documentTarget,
      isVisible: () => true,
      fetchCount,
      setIntervalFn: () => 'interval',
      clearIntervalFn: vi.fn(),
    });

    await vi.waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(1));
    windowTarget.dispatchEvent(new Event('focus'));
    windowTarget.dispatchEvent(new Event(INBOX_ATTENTION_CHANGED_EVENT));
    expect(fetchCount).toHaveBeenCalledTimes(1);

    resolvers[0]?.(7);
    await vi.waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenCalledWith(7);
    resolvers[1]?.(undefined);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('preserves the last value on failure and aborts active work on cleanup', async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    let activeSignal: AbortSignal | undefined;
    const clearIntervalFn = vi.fn();
    const listener = vi.fn();
    const unsubscribe = subscribeToInboxAttentionCount(listener, {
      windowTarget,
      documentTarget,
      isVisible: () => true,
      fetchCount: vi.fn(
        (signal) =>
          new Promise<number | undefined>((_resolve, reject) => {
            activeSignal = signal;
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
      setIntervalFn: () => 'interval',
      clearIntervalFn,
    });

    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    unsubscribe();
    expect(activeSignal?.aborted).toBe(true);
    expect(clearIntervalFn).toHaveBeenCalledWith('interval');
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('subscribeToInboxAttentionChanged', () => {
  it('notifies and unsubscribes same-tab Inbox listeners', () => {
    const target = new EventTarget();
    const listener = vi.fn();
    const unsubscribe = subscribeToInboxAttentionChanged(listener, target);
    const detail = {
      advanceSelection: true,
      resolvedKey: 'approval:approval_1',
    } as const;

    target.dispatchEvent(
      new CustomEvent(INBOX_ATTENTION_CHANGED_EVENT, { detail }),
    );
    expect(listener).toHaveBeenCalledWith(detail);

    unsubscribe();
    target.dispatchEvent(new Event(INBOX_ATTENTION_CHANGED_EVENT));
    expect(listener).toHaveBeenCalledOnce();
  });
});
