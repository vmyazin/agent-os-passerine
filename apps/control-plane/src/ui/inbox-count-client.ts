export const INBOX_ATTENTION_CHANGED_EVENT =
  'agentos:inbox-attention-changed';

export interface InboxAttentionChangedDetail {
  readonly advanceSelection: boolean;
  readonly resolvedKey: string;
}

const INBOX_COUNT_POLL_INTERVAL_MS = 15_000;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface InboxAttentionPresentation {
  readonly badgeText: string;
  readonly ariaLabel: string;
}

export interface InboxCountSubscriptionOptions {
  readonly windowTarget?: EventTarget;
  readonly documentTarget?: EventTarget;
  readonly isVisible?: () => boolean;
  readonly fetchCount?: (signal: AbortSignal) => Promise<number | undefined>;
  readonly setIntervalFn?: (callback: () => void, delay: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

export function formatInboxAttentionCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export function inboxAttentionAriaLabel(count: number): string {
  return count === 1
    ? 'Inbox, 1 item needs attention'
    : `Inbox, ${count} items need attention`;
}

export function inboxAttentionPresentation(
  count: number,
): InboxAttentionPresentation | undefined {
  if (!Number.isSafeInteger(count) || count <= 0) return undefined;
  return {
    badgeText: formatInboxAttentionCount(count),
    ariaLabel: inboxAttentionAriaLabel(count),
  };
}

export async function fetchInboxAttentionCount(
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<number | undefined> {
  try {
    const response = await fetcher('/api/inbox/count', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('count' in body) ||
      !Number.isSafeInteger(body.count) ||
      (body.count as number) < 0
    )
      return undefined;
    return body.count as number;
  } catch {
    return undefined;
  }
}

export function publishInboxAttentionChanged(
  detail?: InboxAttentionChangedDetail,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(INBOX_ATTENTION_CHANGED_EVENT, { detail }),
  );
}

export function subscribeToInboxAttentionChanged(
  listener: (detail: InboxAttentionChangedDetail | undefined) => void,
  target: EventTarget | undefined =
    typeof window === 'undefined' ? undefined : window,
): () => void {
  if (target === undefined) return () => {};
  const handler = (event: Event) =>
    listener(
      (event as CustomEvent<InboxAttentionChangedDetail | undefined>).detail,
    );
  target.addEventListener(INBOX_ATTENTION_CHANGED_EVENT, handler);
  return () => target.removeEventListener(INBOX_ATTENTION_CHANGED_EVENT, handler);
}

export function subscribeToInboxAttentionCount(
  listener: (count: number) => void,
  options: InboxCountSubscriptionOptions = {},
): () => void {
  const windowTarget =
    options.windowTarget ??
    (typeof window === 'undefined' ? undefined : window);
  const documentTarget =
    options.documentTarget ??
    (typeof document === 'undefined' ? undefined : document);
  if (windowTarget === undefined || documentTarget === undefined) return () => {};

  const isVisible =
    options.isVisible ??
    (() => typeof document !== 'undefined' && document.visibilityState === 'visible');
  const fetchCount = options.fetchCount ?? fetchInboxAttentionCount;
  const setIntervalFn =
    options.setIntervalFn ??
    ((callback: () => void, delay: number) => setInterval(callback, delay));
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as number));

  let activeController: AbortController | undefined;
  let disposed = false;
  let inFlight = false;
  let refreshQueued = false;

  const refresh = async (): Promise<void> => {
    if (disposed || !isVisible()) return;
    if (inFlight) {
      refreshQueued = true;
      return;
    }

    inFlight = true;
    const controller = new AbortController();
    activeController = controller;
    try {
      const count = await fetchCount(controller.signal);
      if (!disposed && count !== undefined) listener(count);
    } catch {
      // Preserve the server-seeded or last known count on transient failures.
    } finally {
      if (activeController === controller) activeController = undefined;
      inFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
    }
  };

  const requestRefresh = () => void refresh();
  const onVisibilityChange = () => {
    if (isVisible()) requestRefresh();
  };

  windowTarget.addEventListener('focus', requestRefresh);
  windowTarget.addEventListener(INBOX_ATTENTION_CHANGED_EVENT, requestRefresh);
  documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  const interval = setIntervalFn(requestRefresh, INBOX_COUNT_POLL_INTERVAL_MS);
  requestRefresh();

  return () => {
    disposed = true;
    activeController?.abort();
    windowTarget.removeEventListener('focus', requestRefresh);
    windowTarget.removeEventListener(
      INBOX_ATTENTION_CHANGED_EVENT,
      requestRefresh,
    );
    documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
    clearIntervalFn(interval);
  };
}
