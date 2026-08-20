import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState } from '../../src/ui/components';
import { InboxView } from '../../src/ui/inbox-view';
import { PageToolbar } from '../../src/ui/page-toolbar';
import { countInboxAttention } from '../../src/ui/rail-status-model';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  await requirePageSession();
  const service = controlPlaneService();
  const [messages, approvals] = await Promise.all([
    service.listInbox(),
    service.listPendingApprovals(),
  ]);
  const pendingCount = countInboxAttention(approvals, messages);
  const isEmpty = messages.length === 0 && approvals.length === 0;

  return (
    <div className="inbox-page">
      <PageToolbar
        action={
          pendingCount > 0 ? (
            <span className="mailbox-count">{pendingCount} pending</span>
          ) : undefined
        }
        description="Agent requests waiting for your decision."
        title="Inbox"
        titleId="inbox-title"
      />
      {isEmpty ? (
        <EmptyState title="Inbox clear">
          Nothing needs your attention right now.
        </EmptyState>
      ) : (
        <InboxView approvals={approvals} messages={messages} />
      )}
    </div>
  );
}
