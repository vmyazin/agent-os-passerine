import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: { baseURL: 'http://localhost:3000' },
  testDir: './tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: {
    command:
      'AGENTOS_E2E_SEED=enabled AGENTOS_REPOSITORY=memory AGENTOS_PUBLIC_URL=http://localhost:3000 GITHUB_CLIENT_ID=e2e GITHUB_CLIENT_SECRET=e2e GITHUB_ALLOWED_LOGIN=test-operator AGENTOS_SESSION_SECRET=0123456789abcdef0123456789abcdef pnpm --filter @agentos/control-plane dev --hostname 127.0.0.1 --port 3000',
    reuseExistingServer: !process.env.CI,
    url: 'http://localhost:3000',
  },
});
