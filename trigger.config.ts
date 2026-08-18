import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? 'proj_rjmrnhpvcjaapuajsbyk',
  runtime: 'node-22',
  maxDuration: 3600,
  dirs: ['./packages/adapters/src/trigger'],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 10_000,
      factor: 2,
      randomize: true,
    },
  },
});
