'use client';

import { useEffect, useState } from 'react';

import type {
  InboxApprovalItem,
  InboxDigest,
  InboxProjection,
  RunNotificationProjection,
} from '../application/control-plane-service';
import {
  createInboxConversation,
  createInboxItems,
  formatRelativeTime,
  formatSpend,
  type InboxItem,
  inboxItemChip,
  inboxItemForRun,
  inboxItemPreview,
  inboxItemProjectName,
  inboxItemRunId,
  inboxItemSender,
  inboxItemSubject,
  notificationSucceeded,
  splitInboxItems,
} from './inbox-view-model';
import { ApprovalActions, ReplyForm } from './mutation-forms';
import { subscribeToInboxAttentionChanged } from './inbox-count-client';

function formatReceived(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function RequestMarker({ item }: { readonly item: InboxItem }) {
  const glyph =
    item.kind === 'approval'
      ? 'A'
      : item.kind === 'question'
        ? '?'
        : notificationSucceeded(item.notification)
          ? '✓'
          : '!';
  return (
    <span
      aria-hidden="true"
      className={`inbox-marker inbox-marker-${item.kind}`}
    >
      {glyph}
    </span>
  );
}

function StatusChip({ item }: { readonly item: InboxItem }) {
  const chip = inboxItemChip(item);
  return <span className={`inbox-chip inbox-chip-${chip.tone}`}>{chip.label}</span>;
}

function ApprovalScopeSummary({
  approval,
}: {
  readonly approval: InboxApprovalItem;
}) {
  const summary = approval.summary;
  if (summary === undefined)
    return <p className="inbox-message-copy">{approval.scopePreview}</p>;
  const decided = approval.status !== 'pending';
  return (
    <div className="inbox-message-copy">
      <p>
        The specification agent scoped
        {summary.title === undefined ? (
          ' this feature'
        ) : (
          <>
            {' '}
            <strong>{summary.title}</strong>
          </>
        )}
        {decided
          ? '. This was the reviewed scope.'
          : '. Approving lets implementation start; rejecting ends the run.'}
      </p>
      {summary.acceptanceTests === undefined ? null : (
        <>
          <p>
            <strong>It is done when these tests pass:</strong>
          </p>
          {summary.acceptanceTests.map((file) => (
            <div className="inbox-acceptance-test" key={file.path}>
              <p>
                <code>{file.path}</code>
              </p>
              <pre className="inbox-acceptance-test-body">{file.content}</pre>
            </div>
          ))}
        </>
      )}
      {summary.requirements === undefined ? null : (
        <>
          <p>
            <strong>It will build:</strong>
          </p>
          <ul>
            {summary.requirements.map((requirement, index) => (
              <li key={index}>{requirement}</li>
            ))}
          </ul>
        </>
      )}
      {summary.criteria === undefined ? null : (
        <>
          <p>
            <strong>It counts as done when:</strong>
          </p>
          <ul>
            {summary.criteria.map((criterion) => (
              <li key={criterion.id}>{criterion.description}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ApprovalMessage({ approval }: { approval: InboxApprovalItem }) {
  const summary = approval.summary;
  const decided = approval.status !== 'pending';
  return (
    <>
      {decided ? (
        <div className="inbox-message-copy">
          <p>
            {approval.decision === 'approved' ? (
              <>
                You approved this scope
                {approval.consumedAt === undefined ? (
                  ''
                ) : (
                  <>
                    {' '}
                    on{' '}
                    <time dateTime={approval.consumedAt}>
                      {formatReceived(approval.consumedAt)} UTC
                    </time>
                  </>
                )}
                . The run continued into implementation.
              </>
            ) : approval.decision === 'rejected' ? (
              <>
                You rejected this scope
                {approval.consumedAt === undefined ? (
                  ''
                ) : (
                  <>
                    {' '}
                    on{' '}
                    <time dateTime={approval.consumedAt}>
                      {formatReceived(approval.consumedAt)} UTC
                    </time>
                  </>
                )}
                . The run ended without making changes.
              </>
            ) : (
              'This request expired before a decision was made.'
            )}
          </p>
          <p>{approval.scopePreview}</p>
        </div>
      ) : (
        <ApprovalScopeSummary approval={approval} />
      )}
      {decided && summary !== undefined ? (
        <details className="inbox-evidence inbox-scope-details">
          <summary>Scope details</summary>
          <ApprovalScopeSummary approval={approval} />
        </details>
      ) : null}
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
      {decided ? null : (
        <ApprovalActions
          approvalId={approval.id}
          scopeHash={approval.scopeHash}
        />
      )}
    </>
  );
}

function QuestionMessage({ message }: { message: InboxProjection }) {
  const conversation = createInboxConversation(message);
  return (
    <>
      <div className="inbox-thread">
        {conversation.map((entry) => (
          <section
            aria-label={
              entry.author === 'operator' ? 'Sent reply' : 'Agent message'
            }
            className={`inbox-thread-entry inbox-thread-${entry.author}`}
            key={`${entry.author}:${entry.at}`}
          >
            <header className="inbox-thread-header">
              <strong>
                {entry.author === 'operator' ? 'You' : 'Agent OS'}
              </strong>
              <span>
                {entry.author === 'operator' ? (
                  <span className="inbox-sent-label">Sent</span>
                ) : null}
                <time dateTime={entry.at}>{formatReceived(entry.at)} UTC</time>
              </span>
            </header>
            <div className="inbox-message-copy">
              {entry.lines.length === 0 ? (
                <p>
                  {entry.author === 'operator'
                    ? 'Reply content unavailable.'
                    : 'The agent requested your input.'}
                </p>
              ) : (
                entry.lines.map((line) => <p key={line}>{line}</p>)
              )}
              {entry.author === 'agent' &&
              message.body.options &&
              message.body.options.length > 0 ? (
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
          </section>
        ))}
      </div>
      {message.status === 'pending' ? (
        <ReplyForm messageId={message.id} />
      ) : null}
    </>
  );
}

function NotificationMessage({
  notification,
}: {
  readonly notification: RunNotificationProjection;
}) {
  const succeeded = notificationSucceeded(notification);
  const outcome = notification.outcome;
  return (
    <div className="inbox-message-copy">
      <p>
        {succeeded
          ? 'The run finished successfully.'
          : (notification.reason ?? 'The run reached a final state.')}
      </p>
      {outcome?.draftPullRequestUrl !== undefined ? (
        <p>
          Review the{' '}
          <a
            href={outcome.draftPullRequestUrl}
            rel="noreferrer"
            target="_blank"
          >
            draft pull request
          </a>
          .
        </p>
      ) : null}
      {outcome?.localBranch !== undefined ? (
        <p>
          The changes are on local branch <code>{outcome.localBranch}</code>
          {outcome.localRepositoryUrl === undefined ? (
            '.'
          ) : (
            <>
              {' '}
              in <code>{outcome.localRepositoryUrl}</code>.
            </>
          )}
        </p>
      ) : null}
      {notification.totalCostUsd === undefined ? null : (
        <p>Total spend: {formatSpend(notification.totalCostUsd)}.</p>
      )}
      <p>
        <a href={`/runs/${notification.runId}`}>Open the full run</a> for
        steps, timeline, and evidence.
      </p>
    </div>
  );
}

function QueueSection({
  items,
  now,
  onSelect,
  selectedKey,
  title,
}: {
  readonly items: readonly InboxItem[];
  readonly now: string;
  readonly onSelect: (key: string) => void;
  readonly selectedKey: string;
  readonly title: string;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="inbox-queue-section">
      <h2 className="inbox-queue-heading">{title}</h2>
      <ol>
        {items.map((item) => {
          const project = inboxItemProjectName(item);
          return (
            <li key={item.key}>
              <button
                aria-pressed={item.key === selectedKey}
                className="inbox-row"
                onClick={() => onSelect(item.key)}
                type="button"
              >
                <RequestMarker item={item} />
                <span className="inbox-row-content">
                  <span className="inbox-row-meta">
                    <span>{inboxItemSender(item)}</span>
                    <time dateTime={item.createdAt}>
                      {formatRelativeTime(now, item.createdAt)}
                    </time>
                  </span>
                  <strong>{inboxItemSubject(item)}</strong>
                  <span className="inbox-row-preview">
                    {inboxItemPreview(item)}
                  </span>
                  <span className="inbox-row-run">
                    <StatusChip item={item} />
                    {project ?? `Run ${inboxItemRunId(item)}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function InboxView({
  digest,
  initialRunId,
  now,
}: {
  readonly digest: InboxDigest;
  readonly initialRunId?: string;
  readonly now: string;
}) {
  const items = createInboxItems(
    digest.approvals,
    digest.messages,
    digest.notifications,
  );
  const { attention, history } = splitInboxItems(items);
  const linkedItem =
    initialRunId === undefined
      ? undefined
      : inboxItemForRun(items, initialRunId);
  const [selectedKey, setSelectedKey] = useState(
    (linkedItem ?? attention[0] ?? items[0])?.key,
  );
  useEffect(
    () =>
      subscribeToInboxAttentionChanged((detail) => {
        if (
          detail?.advanceSelection !== true ||
          detail.resolvedKey !== selectedKey
        )
          return;
        const next = attention.find((item) => item.key !== detail.resolvedKey);
        if (next !== undefined) setSelectedKey(next.key);
      }),
    [attention, selectedKey],
  );
  const selected =
    items.find((item) => item.key === selectedKey) ?? attention[0] ?? items[0]!;
  const selectedKindLabel =
    selected.kind === 'approval'
      ? 'Approval'
      : selected.kind === 'question'
        ? 'Question'
        : 'Notification';

  return (
    <section className="mailbox" aria-label="Inbox mailbox">
      <div className="mailbox-layout">
        <aside className="inbox-queue" aria-label="Agent requests">
          <QueueSection
            items={attention}
            now={now}
            onSelect={setSelectedKey}
            selectedKey={selected.key}
            title="Needs you"
          />
          <QueueSection
            items={history}
            now={now}
            onSelect={setSelectedKey}
            selectedKey={selected.key}
            title={attention.length > 0 ? 'Everything else' : 'History'}
          />
        </aside>

        <article className="inbox-reading-pane" aria-label="Selected request">
          <header className="inbox-message-header">
            <div className="inbox-correspondent">
              <RequestMarker item={selected} />
              <div>
                <span>{inboxItemSender(selected)}</span>
                <small>
                  {inboxItemProjectName(selected) ??
                    `Run ${inboxItemRunId(selected)}`}
                </small>
              </div>
            </div>
            <time dateTime={selected.createdAt}>
              {formatReceived(selected.createdAt)} UTC
            </time>
          </header>
          <div className="inbox-message-subject">
            <span>
              {selectedKindLabel}
              <StatusChip item={selected} />
            </span>
            <h2>{inboxItemSubject(selected)}</h2>
          </div>
          <div className="inbox-message-content">
            {selected.kind === 'approval' ? (
              <ApprovalMessage approval={selected.approval} />
            ) : selected.kind === 'question' ? (
              <QuestionMessage message={selected.message} />
            ) : (
              <NotificationMessage notification={selected.notification} />
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
