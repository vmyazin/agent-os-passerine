import { defineConfig } from '@playwright/test';

const e2eBaseUrl = 'http://127.0.0.1:3107';

export default defineConfig({
  use: { baseURL: e2eBaseUrl },
  testDir: './tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: {
    command:
      'AGENTOS_E2E_SEED=enabled AGENTOS_REPOSITORY=memory AGENTOS_PUBLIC_URL=http://127.0.0.1:3107 GITHUB_CLIENT_ID=e2e GITHUB_CLIENT_SECRET=e2e GITHUB_ALLOWED_LOGIN=test-operator AGENTOS_SESSION_SECRET=0123456789abcdef0123456789abcdef pnpm --filter @agentos/control-plane dev --hostname 127.0.0.1 --port 3107',
    reuseExistingServer: false,
    url: e2eBaseUrl,
  },
});
