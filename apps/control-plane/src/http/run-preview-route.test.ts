import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getRunPreview,
  isRunPreviewAvailable,
  startRunPreview,
  stopRunPreview,
  getRun,
} = vi.hoisted(() => ({
  getRunPreview: vi.fn<() => unknown>(() => undefined),
  isRunPreviewAvailable: vi.fn(() => true),
  startRunPreview: vi.fn(),
  stopRunPreview: vi.fn(async () => undefined),
  getRun: vi.fn(),
}));

vi.mock('../local-system/run-preview', () => ({
  RunPreviewError: class RunPreviewError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  getRunPreview,
  isRunPreviewAvailable,
  startRunPreview,
  stopRunPreview,
}));

vi.mock('../application/runtime', () => ({
  controlPlaneService: () => ({ getRun }),
}));

import { DELETE, GET, POST } from '../../app/api/runs/[id]/preview/route';
import { authConfigFromEnv, issueSession, SESSION_COOKIE } from '../auth/auth';

const RUN_ID = 'run_local';

const context = { params: Promise.resolve({ id: RUN_ID }) };

function browserRequest(method: 'GET' | 'POST' | 'DELETE' = 'POST'): Request {
  const session = issueSession(
    authConfigFromEnv(process.env),
    'operator',
    new Date(),
  );
  return new Request(`http://localhost:3010/api/runs/${RUN_ID}/preview`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${session}`,
      origin: 'http://localhost:3010',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
  });
}

function succeededLocalRun() {
  return {
    id: RUN_ID,
    status: 'succeeded',
    outcome: {
      localBranch: 'agentos/run-local',
      localRepositoryUrl: 'file:///workspaces/todo-app',
    },
  };
}

describe('run preview API route', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENTOS_PUBLIC_URL', 'http://localhost:3010');
    vi.stubEnv('AGENTOS_SESSION_SECRET', '0123456789abcdef0123456789abcdef');
    vi.stubEnv('GITHUB_ALLOWED_LOGIN', 'operator');
    vi.stubEnv('AGENTOS_CLI_TOKEN', 'route-token');
    isRunPreviewAvailable.mockReturnValue(true);
    getRunPreview.mockReturnValue(undefined);
    getRun.mockResolvedValue(succeededLocalRun());
    startRunPreview.mockResolvedValue({
      runId: RUN_ID,
      branch: 'agentos/run-local',
      worktree: '/tmp/agentos-preview-a',
      url: 'http://localhost:4321',
      script: 'dev',
      startedAt: '2026-09-02T10:00:00.000Z',
      status: 'running',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('refuses a CLI token before running anything on this machine', async () => {
    const response = await POST(
      new Request(`http://localhost:3010/api/runs/${RUN_ID}/preview`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer route-token',
          'content-type': 'application/json',
        },
      }),
      { params: Promise.resolve({ id: RUN_ID }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'browser_session_required' },
    });
    expect(startRunPreview).not.toHaveBeenCalled();
  });

  it('refuses every verb when previews are unavailable in this environment', async () => {
    isRunPreviewAvailable.mockReturnValue(false);

    for (const [verb, call] of [
      ['POST', POST],
      ['GET', GET],
      ['DELETE', DELETE],
    ] as const) {
      const response = await call(browserRequest(verb), {
        params: Promise.resolve({ id: RUN_ID }),
      });
      expect(response.status, verb).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'run_preview_unavailable' },
      });
    }
    expect(startRunPreview).not.toHaveBeenCalled();
    expect(stopRunPreview).not.toHaveBeenCalled();
  });

  it('refuses a run that has not succeeded', async () => {
    getRun.mockResolvedValue({ id: RUN_ID, status: 'running' });

    const response = await POST(browserRequest(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'run_preview_not_succeeded' },
    });
    expect(startRunPreview).not.toHaveBeenCalled();
  });

  it('refuses a run whose result is not on this machine', async () => {
    getRun.mockResolvedValue({
      id: RUN_ID,
      status: 'succeeded',
      outcome: { draftPullRequestUrl: 'https://github.com/o/r/pull/7' },
    });

    const response = await POST(browserRequest(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'run_preview_not_local' },
    });
    expect(startRunPreview).not.toHaveBeenCalled();
  });

  it('starts a preview from the run’s local branch and repository path', async () => {
    const response = await POST(browserRequest(), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'running',
      url: 'http://localhost:4321',
    });
    expect(startRunPreview).toHaveBeenCalledWith({
      runId: RUN_ID,
      repository: '/workspaces/todo-app',
      branch: 'agentos/run-local',
    });
  });

  it('reports no preview as a 404 without loading the run', async () => {
    const response = await GET(browserRequest('GET'), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'run_preview_not_started' },
    });
    expect(getRun).not.toHaveBeenCalled();
  });

  it('stops a preview', async () => {
    const response = await DELETE(browserRequest('DELETE'), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ stopped: true });
    expect(stopRunPreview).toHaveBeenCalledWith(RUN_ID);
  });
});
