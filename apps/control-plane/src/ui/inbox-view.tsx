'use client';

import { useState } from 'react';

import type {
  ApprovalProjection,
  InboxProjection,
} from '../application/control-plane-service';
import {
  createInboxItems,
  type InboxItem,
  inboxItemPreview,
  inboxItemSubject,
  inboxMessageLines,
} from './inbox-view-model';
import { ApprovalActions, ReplyForm } from './mutation-forms';

function formatReceived(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function RequestMarker({ kind }: { readonly kind: InboxItem['kind'] }) {
  return (
    <span aria-hidden="true" className={`inbox-marker inbox-marker-${kind}`}>
      {kind === 'approval' ? 'A' : '?'}
    </span>
  );
}

function ApprovalMessage({ approval }: { approval: ApprovalProjection }) {
  return (
    <>
      <p className="inbox-message-copy">{approval.scopePreview}</p>
      <details className="inbox-evidence">
        <summary>Review request details</summary>
        <dl>
          <div>
            <dt>Scope hash</dt>
            <dd>
              <code>{approval.scopeHash}</code>
            </dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>
              <time dateTime={approval.expiresAt}>
                {formatReceived(approval.expiresAt)} UTC
              </time>
            </dd>
          </div>
        </dl>
      </details>
      <ApprovalActions
        approvalId={approval.id}
        scopeHash={approval.scopeHash}
      />
    </>
  );
}

function QuestionMessage({ message }: { message: InboxProjection }) {
  const lines = inboxMessageLines(message.body);
  return (
    <>
      <div className="inbox-message-copy">
        {lines.length === 0 ? (
          <p>The agent requested your input.</p>
        ) : (
          lines.map((line) => <p key={line}>{line}</p>)
        )}
        {message.body.options && message.body.options.length > 0 ? (
          <div className="inbox-options">
            <h3>Suggested options</h3>
            <ul>
              {message.body.options.map((option) => (
                <li key={option}>{option}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {message.status === 'pending' ? (
        <ReplyForm messageId={message.id} />
      ) : (
        <p className="notice" role="status">
          Reply sent
        </p>
      )}
    </>
  );
}

export function InboxView({
  approvals,
  messages,
}: {
  readonly approvals: readonly ApprovalProjection[];
  readonly messages: readonly InboxProjection[];
}) {
  const items = createInboxItems(approvals, messages);
  const [selectedKey, setSelectedKey] = useState(items[0]?.key);
  const selected = items.find((item) => item.key === selectedKey) ?? items[0]!;
  const pendingCount =
    approvals.length +
    messages.filter((message) => message.status === 'pending').length;
  const selectedRunId =
    selected.kind === 'approval'
      ? selected.approval.runId
      : selected.message.runId;

  return (
    <section className="mailbox" aria-labelledby="inbox-title">
      <header className="mailbox-toolbar">
        <div>
          <h1 id="inbox-title">Inbox</h1>
          <p>Agent requests waiting for your decision.</p>
        </div>
        <span className="mailbox-count">{pendingCount} pending</span>
      </header>

      <div className="mailbox-layout">
        <aside className="inbox-queue" aria-label="Agent requests">
          <ol>
            {items.map((item) => {
              const isSelected = item.key === selected.key;
              const runId =
                item.kind === 'approval'
                  ? item.approval.runId
                  : item.message.runId;
              return (
                <li key={item.key}>
                  <button
                    aria-pressed={isSelected}
                    className="inbox-row"
                    onClick={() => setSelectedKey(item.key)}
                    type="button"
                  >
                    <RequestMarker kind={item.kind} />
                    <span className="inbox-row-content">
                      <span className="inbox-row-meta">
                        <span>
                          {item.kind === 'approval' ? 'Approval' : 'Question'}
                        </span>
                        <time dateTime={item.createdAt}>
                          {formatReceived(item.createdAt)}
                        </time>
                      </span>
                      <strong>{inboxItemSubject(item)}</strong>
                      <span className="inbox-row-preview">
                        {inboxItemPreview(item)}
                      </span>
                      <span className="inbox-row-run">Run {runId}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <article className="inbox-reading-pane" aria-label="Selected request">
          <header className="inbox-message-header">
            <div className="inbox-correspondent">
              <RequestMarker kind={selected.kind} />
              <div>
                <span>
                  {selected.kind === 'approval'
                    ? 'Approval agent'
                    : 'Agent question'}
                </span>
                <small>Run {selectedRunId}</small>
              </div>
            </div>
            <time dateTime={selected.createdAt}>
              {formatReceived(selected.createdAt)} UTC
            </time>
          </header>
          <div className="inbox-message-subject">
            <span>
              {selected.kind === 'approval' ? 'Approval' : 'Question'}
            </span>
            <h2>{inboxItemSubject(selected)}</h2>
          </div>
          <div className="inbox-message-content">
            {selected.kind === 'approval' ? (
              <ApprovalMessage approval={selected.approval} />
            ) : (
              <QuestionMessage message={selected.message} />
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
