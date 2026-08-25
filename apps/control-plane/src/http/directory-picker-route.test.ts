import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isLocalDirectoryPickerAvailable, selectLocalDirectory } = vi.hoisted(
  () => ({
    isLocalDirectoryPickerAvailable: vi.fn(() => true),
    selectLocalDirectory: vi.fn(),
  }),
);

vi.mock('../local-system/directory-picker', () => ({
  DirectoryPickerError: class DirectoryPickerError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  isLocalDirectoryPickerAvailable,
  selectLocalDirectory,
}));

import { POST } from '../../app/api/projects/import/select-directory/route';
import {
  authConfigFromEnv,
  issueSession,
  SESSION_COOKIE,
} from '../auth/auth';

function browserRequest(
  overrides: { readonly origin?: string; readonly headers?: HeadersInit } = {},
): Request {
  const session = issueSession(
    authConfigFromEnv(process.env),
    'operator',
    new Date(),
  );
  return new Request(
    'http://localhost:3010/api/projects/import/select-directory',
    {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${session}`,
        origin: overrides.origin ?? 'http://localhost:3010',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        ...overrides.headers,
      },
      body: '{}',
    },
  );
}

describe('local directory picker API route', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENTOS_PUBLIC_URL', 'http://localhost:3010');
    vi.stubEnv(
      'AGENTOS_SESSION_SECRET',
      '0123456789abcdef0123456789abcdef',
    );
    vi.stubEnv('GITHUB_ALLOWED_LOGIN', 'operator');
    vi.stubEnv('AGENTOS_CLI_TOKEN', 'route-token');
    isLocalDirectoryPickerAvailable.mockReturnValue(true);
    selectLocalDirectory.mockResolvedValue({ status: 'cancelled' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('rejects unauthenticated, cross-origin, and CLI requests before opening Finder', async () => {
    const unauthenticated = await POST(
      new Request(
        'http://localhost:3010/api/projects/import/select-directory',
        {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3010',
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
          },
          body: '{}',
        },
      ),
    );
    expect(unauthenticated.status).toBe(401);

    const crossOrigin = await POST(
      browserRequest({ origin: 'https://evil.example' }),
    );
    expect(crossOrigin.status).toBe(403);

    const cliToken = await POST(
      new Request(
        'http://localhost:3010/api/projects/import/select-directory',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer route-token',
            'content-type': 'application/json',
          },
          body: '{}',
        },
      ),
    );
    expect(cliToken.status).toBe(403);
    await expect(cliToken.json()).resolves.toMatchObject({
      error: { code: 'browser_session_required' },
    });
    expect(selectLocalDirectory).not.toHaveBeenCalled();
  });

  it('rejects unavailable runtimes before opening Finder', async () => {
    isLocalDirectoryPickerAvailable.mockReturnValue(false);

    const response = await POST(browserRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'directory_picker_unavailable' },
    });
    expect(selectLocalDirectory).not.toHaveBeenCalled();
  });

  it('returns a selected directory path', async () => {
    selectLocalDirectory.mockResolvedValue({
      status: 'selected',
      path: '/Users/operator/repository',
    });

    const response = await POST(browserRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'selected',
      path: '/Users/operator/repository',
    });
    expect(selectLocalDirectory).toHaveBeenCalledOnce();
  });

  it('returns cancellation without an error', async () => {
    const response = await POST(browserRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'cancelled' });
    expect(selectLocalDirectory).toHaveBeenCalledOnce();
  });
});
