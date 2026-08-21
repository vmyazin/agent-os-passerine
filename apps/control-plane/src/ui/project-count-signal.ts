// src/ui/project-count-signal.ts

/**
 * The rail's project badge is rendered by the server layout, so a project
 * created through a fetch-based step (the setup wizard) leaves it showing a
 * stale count until some later full navigation happens to re-render the
 * layout -- which reads as "the project was not created".
 *
 * router.refresh() looks like the fix and is not: /setup is force-dynamic and
 * sits under a loading.tsx boundary, so refreshing swaps in the fallback,
 * remounts the wizard, and discards every step the operator has completed.
 * A one-value broadcast updates the badge and touches nothing else.
 */
const PROJECT_COUNT_EVENT = 'agentos:project-count';

export function publishProjectCount(count: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PROJECT_COUNT_EVENT, { detail: count }));
}

/** Subscribe to published counts. Returns the unsubscribe function. */
export function subscribeToProjectCount(
  listener: (count: number) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const { detail } = event as CustomEvent<unknown>;
    if (typeof detail === 'number' && Number.isFinite(detail) && detail >= 0)
      listener(detail);
  };
  window.addEventListener(PROJECT_COUNT_EVENT, handler);
  return () => window.removeEventListener(PROJECT_COUNT_EVENT, handler);
}
