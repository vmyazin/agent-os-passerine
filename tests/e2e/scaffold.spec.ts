import { expect, test } from '@playwright/test';
import {
  issueSession,
  SESSION_COOKIE,
} from '../../apps/control-plane/src/auth/auth';

test.beforeEach(async ({ context, page }) => {
  const session = issueSession(
    {
      clientId: 'e2e',
      clientSecret: 'e2e',
      allowedLogin: 'test-operator',
      publicUrl: 'http://127.0.0.1:3107',
      sessionSecret: '0123456789abcdef0123456789abcdef',
    },
    'test-operator',
    new Date(),
  );
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: session,
      url: 'https://127.0.0.1:3107',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  await page.goto('/login');
  const seeded = await page.evaluate(
    async () => (await fetch('/api/test/seed', { method: 'POST' })).ok,
  );
  expect(seeded).toBeTruthy();
});

test('control plane renders its accessible dashboard', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Good morning, test-operator.',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }),
  ).toBeVisible();
});

test('operator can monitor a waiting run and consume a scoped approval', async ({
  page,
}) => {
  await page.goto('/runs/e2e-run');
  await expect(
    page.getByRole('heading', { name: 'Approval inbox monitoring' }),
  ).toBeVisible();
  await expect(page.getByLabel('Run status: Waiting')).toBeVisible();

  await page.goto('/inbox');
  await expect(page.getByText('scope_hash_42')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('scope_hash_42')).not.toBeVisible();
});

test('inbox remains usable on a narrow touch viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/inbox');

  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByLabel('Primary navigation')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});
