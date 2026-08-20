// tests/e2e/scaffold.spec.ts
import { expect, test } from '@playwright/test';
import {
  issueSession,
  SESSION_COOKIE,
} from '../../apps/control-plane/src/auth/auth';
import { PLACEHOLDER_PROJECTS } from '../../apps/control-plane/src/ui/projects-placeholder';
import { timeOfDayGreeting } from '../../apps/control-plane/src/ui/time-of-day-greeting';

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
      name: `${timeOfDayGreeting()}, test-operator.`,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', {
      name: `Projects, ${PLACEHOLDER_PROJECTS.length}`,
    }),
  ).toBeVisible();
});

test('operator can open the projects directory', async ({ page }) => {
  await page.goto('/projects');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Projects' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Placeholder projects' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', {
      name: `Projects, ${PLACEHOLDER_PROJECTS.length}`,
    }),
  ).toHaveAttribute('aria-current', 'page');
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
  await expect(page.getByLabel('Agent requests')).toBeVisible();
  await expect(page.getByLabel('Selected request')).toBeVisible();
  await page.getByRole('button', { name: /Approval requested/ }).click();
  await page.getByText('Review request details').click();
  await expect(page.getByText('scope_hash_42')).toBeVisible();
  await page.getByRole('button', { name: 'Approve request' }).click();
  await expect(page.getByText('scope_hash_42')).not.toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Which deployment window should we use?',
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Your reply')).toBeVisible();
  await page.getByLabel('Your reply').fill('Use Tuesday morning.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(
    page.getByLabel('Sent reply').getByText('Use Tuesday morning.'),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel('Sent reply').getByText('Use Tuesday morning.'),
  ).toBeVisible();
});

test('inbox remains usable on a narrow touch viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/inbox');

  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByLabel('Primary navigation')).toBeVisible();
  await expect(page.getByLabel('Agent requests')).toBeVisible();
  await expect(page.getByLabel('Selected request')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});

test('operator can sign in via the localhost "Get In" bypass CTA', async ({
  context,
  page,
}) => {
  await context.clearCookies();
  await page.goto('/login');

  const getInButton = page.getByRole('link', { name: 'Get In' });
  await expect(getInButton).toBeVisible();
  await getInButton.click();

  await expect(page).toHaveURL('http://127.0.0.1:3107/');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: `${timeOfDayGreeting()}, test-operator.`,
    }),
  ).toBeVisible();
});
