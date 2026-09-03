const ACTIVE_RUN_COUNT_POLL_INTERVAL_MS = 10_000;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ActiveRunPresentation {
  readonly badgeText: string;
  readonly ariaLabel: string;
}

export interface ActiveRunCountSubscriptionOptions {
  readonly windowTarget?: EventTarget;
  readonly documentTarget?: EventTarget;
  readonly isVisible?: () => boolean;
  readonly fetchCount?: (signal: AbortSignal) => Promise<number | undefined>;
  readonly setIntervalFn?: (callback: () => void, delay: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

export function formatActiveRunCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export function activeRunPresentation(
  count: number,
): ActiveRunPresentation | undefined {
  if (!Number.isSafeInteger(count) || count <= 0) return undefined;
  return {
    badgeText: formatActiveRunCount(count),
    ariaLabel:
      count === 1 ? 'Runs, 1 active run' : `Runs, ${count} active runs`,
  };
}

export async function fetchActiveRunCount(
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<number | undefined> {
  try {
    const response = await fetcher('/api/runs/active-count', {
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

export function subscribeToActiveRunCount(
  listener: (count: number) => void,
  options: ActiveRunCountSubscriptionOptions = {},
): () => void {
  const windowTarget =
    options.windowTarget ??
    (typeof window === 'undefined' ? undefined : window);
  const documentTarget =
    options.documentTarget ??
    (typeof document === 'undefined' ? undefined : document);
  if (windowTarget === undefined || documentTarget === undefined)
    return () => {};

  const isVisible =
    options.isVisible ??
    (() =>
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible');
  const fetchCount = options.fetchCount ?? fetchActiveRunCount;
  const setIntervalFn =
    options.setIntervalFn ??
    ((callback: () => void, delay: number) => setInterval(callback, delay));
  const clearIntervalFn =
    options.clearIntervalFn ??
    ((handle: unknown) => clearInterval(handle as number));

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
      // Keep the server seed or last successful value on transient failures.
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
  documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  const interval = setIntervalFn(
    requestRefresh,
    ACTIVE_RUN_COUNT_POLL_INTERVAL_MS,
  );
  requestRefresh();

  return () => {
    disposed = true;
    activeController?.abort();
    windowTarget.removeEventListener('focus', requestRefresh);
    documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
    clearIntervalFn(interval);
  };
}
