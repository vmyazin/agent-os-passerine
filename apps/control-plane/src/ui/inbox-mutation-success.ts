import {
  publishInboxAttentionChanged,
  type InboxAttentionChangedDetail,
} from './inbox-count-client';

export function completeInboxMutation(
  refresh: () => void,
  detail: InboxAttentionChangedDetail,
  publish: (
    detail: InboxAttentionChangedDetail,
  ) => void = publishInboxAttentionChanged,
): void {
  publish(detail);
  refresh();
}
