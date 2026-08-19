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

  // A deployment that has also opted into local experiments
  // (AGENTOS_LOCAL_WORKSPACES_ROOT set) is NOT exempt from eager reader
  // validation once it has started configuring a reader App
  // (GITHUB_READER_APP_ID set): only a genuinely local-only deployment --
  // no reader App id configured at all -- defers reader construction.
  it('still validates the reader eagerly when local workspaces are also configured but a reader App id is set', () => {
    enableDispatch();
    process.env.AGENTOS_LOCAL_WORKSPACES_ROOT = '/workspaces/experiments';
    process.env.GITHUB_APP_ID = '42';
    process.env.GITHUB_READER_APP_ID = '42';

    expect(() => workflowDispatchFromEnv()).toThrow(
      'must identify a separate read-only GitHub App',
    );
  });

  it('still requires the separate reader private key when local workspaces are also configured', () => {
    enableDispatch();
    process.env.AGENTOS_LOCAL_WORKSPACES_ROOT = '/workspaces/experiments';
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

  it('defers reader validation for a genuinely local-only deployment (no reader App id at all)', () => {
    enableDispatch();
    process.env.AGENTOS_LOCAL_WORKSPACES_ROOT = '/workspaces/experiments';
    delete process.env.GITHUB_READER_APP_ID;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_SELECTED_REPOSITORIES_JSON;

    // No GitHub reader/publisher env at all: construction must not throw
    // trying to validate a reader this deployment will never use. (It will
    // still fail later, for an unrelated reason -- no R2 env configured --
    // proving reader validation specifically was skipped, not that
    // everything happened to succeed.)
    expect(() => workflowDispatchFromEnv()).toThrow(
      'CLOUDFLARE_R2_ACCOUNT_ID is required',
    );
  });
});
