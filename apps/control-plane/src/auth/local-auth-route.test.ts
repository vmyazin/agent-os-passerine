import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from '../../app/auth/local/route';
import {
  authConfigFromEnv,
  OAUTH_COOKIE,
  readSession,
  SESSION_COOKIE,
} from './auth';

describe('Local authentication bypass route', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENTOS_PUBLIC_URL', 'http://localhost:3000');
    vi.stubEnv('AGENTOS_SESSION_SECRET', '0123456789abcdef0123456789abcdef');
    vi.stubEnv('GITHUB_ALLOWED_LOGIN', 'local-tester');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('handles GET on localhost, issues session, and redirects to root by default', async () => {
    const request = new Request('http://localhost:3000/auth/local');
    const response = GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');

    const setCookies = response.headers.getSetCookie();
    const sessionCookieHeader = setCookies.find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    const oauthCookieHeader = setCookies.find((c) =>
      c.startsWith(`${OAUTH_COOKIE}=`),
    );

    expect(sessionCookieHeader).toBeTruthy();
    expect(sessionCookieHeader).toContain('Max-Age=28800');
    expect(sessionCookieHeader).toContain('HttpOnly');
    expect(oauthCookieHeader).toContain('Max-Age=0');

    const cookieMatch = sessionCookieHeader?.match(
      new RegExp(`${SESSION_COOKIE}=([^;]+)`),
    );
    const sessionToken = cookieMatch?.[1];
    expect(sessionToken).toBeTruthy();

    const config = authConfigFromEnv(process.env);
    const session = readSession(config, sessionToken);
    expect(session).toMatchObject({
      login: 'local-tester',
    });
  });

  it('handles GET with a returnTo query parameter', async () => {
    const request = new Request(
      'http://localhost:3000/auth/local?returnTo=/runs%3Fstatus%3Dwaiting',
    );
    const response = GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/runs?status=waiting',
    );
  });

  it('handles POST with form-data returnTo and 303 redirect', async () => {
    const formData = new FormData();
    formData.set('returnTo', '/inbox');
    const request = new Request('http://localhost:3000/auth/local', {
      method: 'POST',
      body: formData,
    });
    const response = await POST(request);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/inbox',
    );

    const setCookies = response.headers.getSetCookie();
    const sessionCookieHeader = setCookies.find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(sessionCookieHeader).toBeTruthy();
  });

  it('rejects GET and POST with 403 when in production mode', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AGENTOS_PUBLIC_URL', 'https://control.example');

    const getRes = GET(new Request('https://control.example/auth/local'));
    expect(getRes.status).toBe(403);

    const postRes = await POST(
      new Request('https://control.example/auth/local', { method: 'POST' }),
    );
    expect(postRes.status).toBe(403);
  });

  it('rejects GET and POST with 403 when host is not localhost', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENTOS_PUBLIC_URL', 'https://remote-dev.example');
    vi.stubEnv('GITHUB_CLIENT_ID', 'id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'secret');

    const getRes = GET(new Request('https://remote-dev.example/auth/local'));
    expect(getRes.status).toBe(403);

    const postRes = await POST(
      new Request('https://remote-dev.example/auth/local', { method: 'POST' }),
    );
    expect(postRes.status).toBe(403);
  });
});
