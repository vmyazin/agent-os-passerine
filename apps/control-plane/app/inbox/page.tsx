import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState } from '../../src/ui/components';
import { ApprovalActions, ReplyForm } from '../../src/ui/mutation-forms';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  await requirePageSession();
  const service = controlPlaneService();
  const [messages, approvals] = await Promise.all([
    service.listInbox(),
    service.listPendingApprovals(),
  ]);
  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="inbox-title">
        <p className="eyebrow">Human in the loop</p>
        <h1 id="inbox-title">Inbox</h1>
        <p>Resolve questions and narrowly scoped approvals.</p>
      </section>
      {messages.length === 0 && approvals.length === 0 ? (
        <EmptyState title="Inbox clear">
          Nothing needs your attention right now.
        </EmptyState>
      ) : (
        <div className="card-grid">
          {approvals.map((approval) => (
            <article className="inbox-card" key={approval.id}>
              <p className="card-kind">Approval</p>
              <h2>{approval.scope}</h2>
              <dl>
                <dt>Scope hash</dt>
                <dd>
                  <code>{approval.fingerprint}</code>
                </dd>
                <dt>Expires</dt>
                <dd>{approval.expiresAt}</dd>
              </dl>
              <ApprovalActions approvalId={approval.id} />
            </article>
          ))}
          {messages.map((message) => (
            <article className="inbox-card" key={message.id}>
              <p className="card-kind">Question</p>
              <h2>Run {message.runId}</h2>
              <pre className="message-body">
                {JSON.stringify(message.body, null, 2)}
              </pre>
              {message.status === 'pending' ? (
                <ReplyForm messageId={message.id} />
              ) : (
                <p className="notice">Replied</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
