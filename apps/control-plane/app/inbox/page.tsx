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
  const digest = await service.inboxDigest();
  const pendingCount = countInboxAttention(
    digest.approvals.filter((approval) => approval.status === 'pending'),
    digest.messages,
  );
  const isEmpty =
    digest.messages.length === 0 &&
    digest.approvals.length === 0 &&
    digest.notifications.length === 0;

  return (
    <div className="inbox-page">
      <PageToolbar
        action={
          pendingCount > 0 ? (
            <span className="mailbox-count">{pendingCount} pending</span>
          ) : undefined
        }
        description="Messages and updates from your agents."
        title="Inbox"
        titleId="inbox-title"
      />
      {isEmpty ? (
        <EmptyState title="Inbox clear">
          Nothing needs your attention right now.
        </EmptyState>
      ) : (
        <InboxView digest={digest} now={new Date().toISOString()} />
      )}
    </div>
  );
}
