import { afterEach, describe, expect, it } from 'vitest';

import { workflowDispatchFromEnv } from './runtime';
import { resetRepositoryForTests } from '../persistence/repository-factory';

const saved = { ...process.env };

afterEach(() => {
  resetRepositoryForTests();
  process.env = { ...saved };
});

function enableDispatch() {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    AGENTOS_REPOSITORY: 'memory',
    TRIGGER_SECRET_KEY: 'tr_test',
    DATABASE_URL: 'postgres://unused',
  });
  process.env.GITHUB_SELECTED_REPOSITORIES_JSON = JSON.stringify([
    {
      installationId: 1,
      owner: 'team',
      name: 'repo',
      repositoryId: 3,
    },
  ]);
}

describe('control-plane GitHub reader identity', () => {
  it('rejects reuse of the publisher GitHub App identity', () => {
    enableDispatch();
    process.env.GITHUB_APP_ID = '42';
    process.env.GITHUB_READER_APP_ID = '42';

    expect(() => workflowDispatchFromEnv()).toThrow(
      'must identify a separate read-only GitHub App',
    );
  });

  it('requires the separate reader private key by its actionable name', () => {
    enableDispatch();
    process.env.GITHUB_APP_ID = '42';
    process.env.GITHUB_READER_APP_ID = '43';
    process.env.GITHUB_READER_SELECTED_REPOSITORIES_JSON = JSON.stringify([
      {
        installationId: 2,
        owner: 'team',
        name: 'repo',
        repositoryId: 3,
      },
    ]);

    expect(() => workflowDispatchFromEnv()).toThrow(
      'GITHUB_READER_APP_PRIVATE_KEY is required',
    );
  });
});
