import { describe, expect, it, vi } from 'vitest';

import { completeInboxMutation } from './inbox-mutation-success';

describe('completeInboxMutation', () => {
  it('publishes the invalidation before refreshing the current route', () => {
    const order: string[] = [];
    const publish = vi.fn(() => order.push('publish'));
    const refresh = vi.fn(() => order.push('refresh'));
    const detail = {
      advanceSelection: true,
      resolvedKey: 'approval:approval_1',
    } as const;

    completeInboxMutation(refresh, detail, publish);

    expect(order).toEqual(['publish', 'refresh']);
    expect(publish).toHaveBeenCalledWith(detail);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
