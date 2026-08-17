import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState } from '../../src/ui/components';
import { InboxView } from '../../src/ui/inbox-view';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  await requirePageSession();
  const service = controlPlaneService();
  const [messages, approvals] = await Promise.all([
    service.listInbox(),
    service.listPendingApprovals(),
  ]);
  const isEmpty = messages.length === 0 && approvals.length === 0;
  return (
    <div className="inbox-page">
      {isEmpty ? (
        <>
          <section
            className="inbox-empty-heading"
            aria-labelledby="inbox-title"
          >
            <h1 id="inbox-title">Inbox</h1>
            <p>Agent requests waiting for your decision.</p>
          </section>
          <EmptyState title="Inbox clear">
            Nothing needs your attention right now.
          </EmptyState>
        </>
      ) : (
        <InboxView approvals={approvals} messages={messages} />
      )}
    </div>
  );
}
