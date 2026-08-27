// tests/e2e/scaffold.spec.ts
import { expect, test } from '@playwright/test';
import {
  issueSession,
  SESSION_COOKIE,
} from '../../apps/control-plane/src/auth/auth';
import { timeOfDayGreeting } from '../../apps/control-plane/src/ui/time-of-day-greeting';

test.beforeEach(async ({ context, page }, testInfo) => {
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
  // /login redirects signed-in operators, which destroyed the old
  // evaluate() context. Hit a public JSON route so the origin cookie
  // is available without rendering the app shell or HomePage first.
  await page.goto('/api/health');
  // The import flow deliberately starts from an empty in-memory directory and
  // does not need the unrelated artifact fixture (which is immutable across
  // repeated local smoke runs).
  if (
    testInfo.title.includes('keyboard-import') ||
    testInfo.title.includes('folder picker')
  )
    return;
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
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Sign Out' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Projects, 1' })).toBeVisible();
});

test('operator can open projects from the metric card by keyboard', async ({
  page,
}) => {
  await page.goto('/');

  const summary = page.getByRole('region', { name: 'Workspace summary' });
  const projectsMetric = summary.getByRole('link', {
    name: 'Projects 1 1 project',
  });
  await projectsMetric.focus();
  await expect(projectsMetric).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL('/projects');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Projects' }),
  ).toBeVisible();
});

test('operator can open the projects directory', async ({ page }) => {
  await page.goto('/projects');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Projects' }),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'E2E Project' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Projects, 1' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('operator can keyboard-import a local project and browse commits', async ({
  page,
}) => {
  await page.goto('/projects');
  const trigger = page.getByRole('button', { name: 'Import project' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Import an existing project' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();

  await trigger.click();
  const local = page.getByRole('radio', { name: 'Local repository' });
  await local.focus();
  await page.keyboard.press('Space');
  await expect(local).toBeChecked();
  await page
    .getByLabel('Repository path', { exact: true })
    .fill(process.cwd());
  await page.getByRole('button', { name: 'Inspect repository' }).click();
  await expect(page.getByText('Repository found')).toBeVisible();
  await expect(page.getByLabel('Default branch')).toHaveValue(/\S+/);
  await page.getByRole('button', { name: 'Import and open project' }).click();

  await expect(page).toHaveURL(/\/projects\/project_/);
  await expect(
    page.getByRole('heading', { level: 2, name: 'Commit history' }),
  ).toBeVisible();
  await expect(page.getByText('Default branch')).toBeVisible();
  await expect(page.locator('.commit-feed-item').first()).toBeVisible();

  const loadMore = page.getByRole('button', { name: 'Load 25 more' });
  if (await loadMore.isVisible()) {
    const loadedRows = await page.locator('.commit-feed-item').count();
    await page.route('**/api/projects/*/commits?cursor=*', async (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'provider_unavailable', message: 'Unavailable' },
        }),
      }),
    );
    await loadMore.click();
    await expect(page.getByText('Could not load more commits.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.locator('.commit-feed-item')).toHaveCount(loadedRows);
  }
});

test('operator can populate a local repository path with the folder picker', async ({
  page,
}) => {
  let pickerRequest = 0;
  await page.route(
    '**/api/projects/import/select-directory',
    async (route) => {
      pickerRequest += 1;
      if (pickerRequest === 1) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'selected',
            path: process.cwd(),
          }),
        });
        return;
      }
      if (pickerRequest === 2) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ status: 'cancelled' }),
        });
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'directory_picker_failed',
            message: 'Could not open the macOS folder picker.',
          },
        }),
      });
    },
  );
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Import project' }).click();
  await page.getByRole('radio', { name: 'Local repository' }).click();

  const path = page.getByLabel('Repository path', { exact: true });
  const choose = page.getByRole('button', { name: 'Choose folder…' });
  await choose.click();
  await expect(path).toHaveValue(process.cwd());
  await expect(path).toBeFocused();

  await path.fill('/Users/operator/keep-this-path');
  await choose.click();
  await expect(path).toHaveValue('/Users/operator/keep-this-path');

  await choose.click();
  await expect(path).toHaveValue('/Users/operator/keep-this-path');
  await expect(
    page.getByText('Could not open the macOS folder picker.'),
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
  const primaryNavigation = page.getByRole('navigation', {
    name: 'Primary navigation',
  });
  await expect(
    primaryNavigation.getByRole('link', {
      name: 'Inbox, 3 items need attention',
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Agent requests')).toBeVisible();
  await expect(page.getByLabel('Selected request')).toBeVisible();
  await page
    .getByRole('button', { name: /Approval requested.*Merge pull request #42/ })
    .click();
  await page.getByText('Review request details').click();
  await expect(page.getByText('scope_hash_42')).toBeVisible();
  await page.evaluate(() => {
    (
      window as Window & { __agentosInboxDocumentMarker?: string }
    ).__agentosInboxDocumentMarker = 'preserved';
  });
  await page.getByRole('button', { name: 'Approve request' }).click();
  await expect(
    primaryNavigation.getByRole('link', {
      name: 'Inbox, 2 items need attention',
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __agentosInboxDocumentMarker?: string })
          .__agentosInboxDocumentMarker,
    ),
  ).toBe('preserved');
  await expect(page.getByText('scope_hash_42')).not.toBeVisible();
  await page
    .getByRole('button', { name: /Which deployment window should we use/ })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Which deployment window should we use?',
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Your reply')).toBeVisible();
  await page.getByLabel('Your reply').fill('Use Tuesday morning.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(
    primaryNavigation.getByRole('link', {
      name: 'Inbox, 1 item needs attention',
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __agentosInboxDocumentMarker?: string })
          .__agentosInboxDocumentMarker,
    ),
  ).toBe('preserved');
  await expect(page.getByText('Reply sent')).toBeVisible();
  await page
    .getByRole('button', { name: /Which deployment window should we use/ })
    .click();
  await expect(
    page.getByLabel('Sent reply').getByText('Use Tuesday morning.'),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('button', { name: /Which deployment window should we use/ })
    .click();
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
  await expect(page.getByRole('button', { name: 'Sign Out' })).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }),
  ).toHaveCount(0);
  await getInButton.click();

  await expect(page).toHaveURL('http://127.0.0.1:3107/');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: `${timeOfDayGreeting()}, test-operator.`,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Sign Out' }),
  ).toBeVisible();
});
