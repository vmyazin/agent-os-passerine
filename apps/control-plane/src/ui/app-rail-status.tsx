// src/ui/app-rail-status.tsx
import { controlPlaneService } from '../application/runtime';
import { countInboxAttention } from './rail-status-model';

export async function AppRailStatus() {
  // Rendered in the layout on every page as a compact top bar: use the
  // cheap primitives (no per-run projections, no artifact-backed approval
  // summaries), and fail soft — a status badge must never take the page down.
  let inboxCount: number;
  let waitingCount: number;
  try {
    const service = controlPlaneService();
    const [messages, approvals, waiting] = await Promise.all([
      service.listInbox(),
      service.listPendingApprovals(50, false),
      service.countRunsByStatus('waiting'),
    ]);
    inboxCount = countInboxAttention(approvals, messages);
    waitingCount = waiting;
  } catch {
    return null;
  }

  if (inboxCount === 0 && waitingCount === 0) {
    return null;
  }

  return (
    <header aria-label="Workspace status" className="app-status-bar">
      {inboxCount > 0 ? (
        <a className="status-badge status-badge-attention" href="/inbox">
          {inboxCount} need you
        </a>
      ) : null}
      {waitingCount > 0 ? (
        <a className="status-badge status-badge-neutral" href="/runs">
          {waitingCount} waiting
        </a>
      ) : null}
    </header>
  );
}
