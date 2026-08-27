import type {
  InboxApprovalItem,
  InboxProjection,
  RunNotificationProjection,
  SafeInboxContent,
} from '../application/control-plane-service';

export type InboxItem =
  | {
      readonly kind: 'approval';
      readonly key: string;
      readonly createdAt: string;
      readonly approval: InboxApprovalItem;
    }
  | {
      readonly kind: 'question';
      readonly key: string;
      readonly createdAt: string;
      readonly message: InboxProjection & { readonly projectName?: string };
    }
  | {
      readonly kind: 'notification';
      readonly key: string;
      readonly createdAt: string;
      readonly notification: RunNotificationProjection;
    };

export interface InboxConversationEntry {
  readonly author: 'agent' | 'operator';
  readonly at: string;
  readonly lines: readonly string[];
}

export interface InboxChip {
  readonly label: string;
  readonly tone: 'attention' | 'positive' | 'negative' | 'neutral';
}

export function inboxMessageLines(body: SafeInboxContent): readonly string[] {
  const lines = [body.question, body.message, body.text, body.answer].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return [...new Set(lines)];
}

export function createInboxConversation(
  message: InboxProjection,
): readonly InboxConversationEntry[] {
  const conversation: InboxConversationEntry[] = [
    {
      author: 'agent',
      at: message.createdAt,
      lines: inboxMessageLines(message.body),
    },
  ];
  if (message.reply !== undefined) {
    conversation.push({
      author: 'operator',
      at: message.repliedAt ?? message.createdAt,
      lines: inboxMessageLines(message.reply),
    });
  }
  return conversation;
}

function notificationHeadline(notification: RunNotificationProjection): string {
  const noun = notification.pipeline === 'goal' ? 'Goal' : 'Run';
  switch (notification.resultStatus ?? notification.runStatus) {
    case 'succeeded':
      return `${noun} complete`;
    case 'rejected':
      return `${noun} rejected`;
    case 'expired':
      return `${noun} expired`;
    case 'budget_exhausted':
      return `${noun} stopped: budget exhausted`;
    case 'cancelled':
      return `${noun} cancelled`;
    default:
      return `${noun} failed`;
  }
}

export function notificationSucceeded(
  notification: RunNotificationProjection,
): boolean {
  return (
    notification.runStatus === 'succeeded' &&
    (notification.resultStatus ?? 'succeeded') === 'succeeded'
  );
}

export function formatSpend(totalCostUsd: number): string {
  return `$${totalCostUsd.toFixed(2)}`;
}

export function inboxItemSubject(item: InboxItem): string {
  if (item.kind === 'approval') return 'Approval requested';
  if (item.kind === 'question')
    return inboxMessageLines(item.message.body)[0] ?? 'Agent question';
  const headline = notificationHeadline(item.notification);
  const title = item.notification.title;
  const subject = title === undefined ? headline : `${headline}: ${title}`;
  return notificationSucceeded(item.notification) ? `${subject} ✓` : subject;
}

export function inboxItemPreview(item: InboxItem): string {
  if (item.kind === 'approval') {
    if (item.approval.decision === 'approved')
      return 'You approved this scope; the run continued.';
    if (item.approval.decision === 'rejected')
      return 'You rejected this scope; the run ended.';
    if (item.approval.status === 'expired')
      return 'This request expired before a decision.';
    return item.approval.scopePreview;
  }
  if (item.kind === 'question') {
    if (item.message.status === 'replied') return 'Reply sent';
    const options = item.message.body.options;
    return options && options.length > 0
      ? `${options.length} suggested options`
      : 'Reply requested';
  }
  const notification = item.notification;
  const parts: string[] = [];
  if (notification.outcome?.draftPullRequestUrl !== undefined)
    parts.push('Draft pull request opened.');
  else if (notification.outcome?.localBranch !== undefined)
    parts.push(`Local branch ${notification.outcome.localBranch}.`);
  else if (notification.reason !== undefined) parts.push(notification.reason);
  if (notification.totalCostUsd !== undefined)
    parts.push(`Total spend: ${formatSpend(notification.totalCostUsd)}.`);
  return parts.length > 0 ? parts.join(' ') : 'The run reached a final state.';
}

export function inboxItemSender(item: InboxItem): string {
  return item.kind === 'question' ? 'Agent' : 'System';
}

export function inboxItemChip(item: InboxItem): InboxChip {
  if (item.kind === 'approval') {
    if (item.approval.status === 'pending')
      return { label: 'Awaiting decision', tone: 'attention' };
    if (item.approval.status === 'expired')
      return { label: 'Expired', tone: 'neutral' };
    return item.approval.decision === 'rejected'
      ? { label: 'Rejected', tone: 'negative' }
      : { label: 'Approved', tone: 'positive' };
  }
  if (item.kind === 'question') {
    return item.message.status === 'pending'
      ? { label: 'Awaiting reply', tone: 'attention' }
      : { label: 'Answered', tone: 'positive' };
  }
  if (notificationSucceeded(item.notification))
    return { label: 'Completed', tone: 'positive' };
  const status = item.notification.resultStatus ?? item.notification.runStatus;
  return status === 'cancelled' || status === 'expired'
    ? { label: 'Ended', tone: 'neutral' }
    : { label: 'Failed', tone: 'negative' };
}

export function inboxItemNeedsAttention(item: InboxItem): boolean {
  if (item.kind === 'approval') return item.approval.status === 'pending';
  if (item.kind === 'question') return item.message.status === 'pending';
  return false;
}

export function inboxItemRunId(item: InboxItem): string {
  if (item.kind === 'approval') return item.approval.runId;
  if (item.kind === 'question') return item.message.runId;
  return item.notification.runId;
}

/**
 * Resolve a run deep-link to the request the operator can act on now.
 * A run may retain older questions and approvals in its history, so pending
 * work wins; the existing newest-first order breaks ties deterministically.
 */
export function inboxItemForRun(
  items: readonly InboxItem[],
  runId: string,
): InboxItem | undefined {
  return (
    items.find(
      (item) => inboxItemRunId(item) === runId && inboxItemNeedsAttention(item),
    ) ?? items.find((item) => inboxItemRunId(item) === runId)
  );
}

export function inboxItemProjectName(item: InboxItem): string | undefined {
  if (item.kind === 'approval') return item.approval.projectName;
  if (item.kind === 'question') return item.message.projectName;
  return item.notification.projectName;
}

/**
 * "24m ago"-style timestamps, relative to a caller-supplied instant so the
 * server render and client hydration agree. Falls back to a short absolute
 * date once an item is more than a week old.
 */
export function formatRelativeTime(
  nowIso: string,
  thenIso: string,
  timeZone = 'UTC',
): string {
  const elapsedMs = Date.parse(nowIso) - Date.parse(thenIso);
  if (!Number.isFinite(elapsedMs)) return thenIso;
  if (elapsedMs < 60_000) return 'just now';
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone,
  }).format(new Date(thenIso));
}

export function createInboxItems(
  approvals: readonly InboxApprovalItem[],
  messages: readonly (InboxProjection & { readonly projectName?: string })[],
  notifications: readonly RunNotificationProjection[] = [],
): readonly InboxItem[] {
  return [
    ...approvals.map((approval): InboxItem => ({
      kind: 'approval',
      key: `approval:${approval.id}`,
      createdAt: approval.createdAt,
      approval,
    })),
    ...messages.map((message): InboxItem => ({
      kind: 'question',
      key: `question:${message.id}`,
      createdAt: message.createdAt,
      message,
    })),
    ...notifications.map((notification): InboxItem => ({
      kind: 'notification',
      key: `notification:${notification.runId}`,
      createdAt: notification.completedAt,
      notification,
    })),
  ].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      left.key.localeCompare(right.key),
  );
}

/**
 * The queue's two sections: items still waiting on the operator, then the
 * permanent record. Nothing is ever dropped — a decided approval or finished
 * run moves down instead of disappearing.
 */
export function splitInboxItems(items: readonly InboxItem[]): {
  readonly attention: readonly InboxItem[];
  readonly history: readonly InboxItem[];
} {
  return {
    attention: items.filter(inboxItemNeedsAttention),
    history: items.filter((item) => !inboxItemNeedsAttention(item)),
  };
}
