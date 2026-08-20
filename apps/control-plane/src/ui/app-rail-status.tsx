// src/ui/app-rail-status.tsx
import { controlPlaneService } from '../application/runtime';
import {
  countInboxAttention,
  countWaitingRuns,
} from './rail-status-model';

export async function AppRailStatus() {
  const service = controlPlaneService();
  const [messages, approvals, runs] = await Promise.all([
    service.listInbox(),
    service.listPendingApprovals(),
    service.listRuns(50),
  ]);
  const inboxCount = countInboxAttention(approvals, messages);
  const waitingCount = countWaitingRuns(runs);

  if (inboxCount === 0 && waitingCount === 0) {
    return null;
  }

  return (
    <div className="app-rail-badges">
      {inboxCount > 0 ? (
        <a className="rail-badge rail-badge-attention" href="/inbox">
          {inboxCount} need you
        </a>
      ) : null}
      {waitingCount > 0 ? (
        <a className="rail-badge rail-badge-neutral" href="/runs">
          {waitingCount} waiting
        </a>
      ) : null}
    </div>
  );
}
