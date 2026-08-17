import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    baseURL: 'http://127.0.0.1:3000',
  },
  testDir: './tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: {
    command:
      'pnpm --filter @agentos/control-plane start --hostname 127.0.0.1 --port 3000',
    reuseExistingServer: !process.env.CI,
    url: 'http://127.0.0.1:3000',
  },
});
