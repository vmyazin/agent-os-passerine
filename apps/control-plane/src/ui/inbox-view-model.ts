import type {
  ApprovalProjection,
  InboxProjection,
  SafeInboxContent,
} from '../application/control-plane-service';

export type InboxItem =
  | {
      readonly kind: 'approval';
      readonly key: string;
      readonly createdAt: string;
      readonly approval: ApprovalProjection;
    }
  | {
      readonly kind: 'question';
      readonly key: string;
      readonly createdAt: string;
      readonly message: InboxProjection;
    };

export interface InboxConversationEntry {
  readonly author: 'agent' | 'operator';
  readonly at: string;
  readonly lines: readonly string[];
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

export function inboxItemSubject(item: InboxItem): string {
  return item.kind === 'approval'
    ? 'Approval requested'
    : (inboxMessageLines(item.message.body)[0] ?? 'Agent question');
}

export function inboxItemPreview(item: InboxItem): string {
  if (item.kind === 'approval') return item.approval.scopePreview;
  if (item.message.status === 'replied') return 'Reply sent';
  const options = item.message.body.options;
  return options && options.length > 0
    ? `${options.length} suggested options`
    : 'Reply requested';
}

export function createInboxItems(
  approvals: readonly ApprovalProjection[],
  messages: readonly InboxProjection[],
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
  ].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      left.key.localeCompare(right.key),
  );
}
