import { expect, test } from '@playwright/test';

import { INBOX_ATTENTION_CHANGED_EVENT } from '../../apps/control-plane/src/ui/inbox-count-client';

test('inbox rail count refreshes without navigation', async ({ page }) => {
  let count = 2;
  let fail = false;
  await page.route('**/api/inbox/count', async (route) => {
    if (fail) {
      await route.fulfill({ status: 503, body: 'Unavailable' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count }),
    });
  });

  await page.goto('/auth/local');
  const navigation = page.getByRole('navigation', {
    name: 'Primary navigation',
  });
  const inboxLink = (name: string) =>
    navigation.getByRole('link', { name, exact: true });

  await expect(inboxLink('Inbox, 2 items need attention')).toBeVisible();

  count = 143;
  await page.evaluate(
    (eventName) => window.dispatchEvent(new Event(eventName)),
    INBOX_ATTENTION_CHANGED_EVENT,
  );
  await expect(inboxLink('Inbox, 143 items need attention')).toBeVisible();
  await expect(
    inboxLink('Inbox, 143 items need attention').locator('.rail-nav-count'),
  ).toHaveText('99+');

  fail = true;
  const failedRefresh = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/inbox/count') && response.status() === 503,
  );
  await page.evaluate(
    (eventName) => window.dispatchEvent(new Event(eventName)),
    INBOX_ATTENTION_CHANGED_EVENT,
  );
  await failedRefresh;
  await expect(inboxLink('Inbox, 143 items need attention')).toBeVisible();

  fail = false;
  count = 0;
  await page.evaluate(
    (eventName) => window.dispatchEvent(new Event(eventName)),
    INBOX_ATTENTION_CHANGED_EVENT,
  );
  await expect(inboxLink('Inbox')).toBeVisible();
  await expect(inboxLink('Inbox').locator('.rail-nav-count')).toHaveCount(0);
});
