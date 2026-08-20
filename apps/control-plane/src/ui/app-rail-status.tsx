// src/ui/app-rail-status.tsx
import type { RailCounts } from './rail-counts';

export function AppRailStatus({
  counts,
}: {
  readonly counts: RailCounts | undefined;
}) {
  // Rendered in the layout on every page as a compact top bar. Counts
  // arrive from the layout's single fail-soft fetch; an unavailable
  // control plane renders no badges rather than an error.
  if (
    counts === undefined ||
    (counts.inboxCount === 0 && counts.waitingCount === 0)
  ) {
    return null;
  }

  return (
    <header aria-label="Workspace status" className="app-status-bar">
      {counts.inboxCount > 0 ? (
        <a className="status-badge status-badge-attention" href="/inbox">
          {counts.inboxCount} need you
        </a>
      ) : null}
      {counts.waitingCount > 0 ? (
        <a className="status-badge status-badge-neutral" href="/runs">
          {counts.waitingCount} waiting
        </a>
      ) : null}
    </header>
  );
}
