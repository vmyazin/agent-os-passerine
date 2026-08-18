import { describe, expect, it } from 'vitest';

import {
  authConfigFromEnv,
  createAuthorizationRequest,
  isLocalhost,
  isLocalhostBypassAllowed,
  issueSession,
  readSession,
  sanitizeReturnTo,
  secureCookie,
  verifyCallback,
} from './auth';

const config = {
  clientId: 'client',
  clientSecret: 'secret',
  allowedLogin: 'operator',
  publicUrl: 'https://control.example',
  sessionSecret: '0123456789abcdef0123456789abcdef',
};
const now = new Date('2026-08-17T12:00:00.000Z');

describe('GitHub OAuth authentication', () => {
  it('uses state, PKCE, and a sanitized return location', () => {
    const result = createAuthorizationRequest(
      config,
      now,
      '/runs?status=waiting',
    );

    expect(result.url.origin).toBe('https://github.com');
    expect(result.url.searchParams.get('state')).toBeTruthy();
    expect(result.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(result.cookie).not.toContain('returnTo');
  });

  it('rejects callback state mismatch and expired state', async () => {
    const request = createAuthorizationRequest(config, now, '/');

    await expect(
      verifyCallback(
        config,
        request.cookie,
        'wrong',
        'code',
        now,
        async () => ({
          login: 'operator',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_oauth_state' });
    await expect(
      verifyCallback(
        config,
        request.cookie,
        request.state,
        'code',
        new Date(now.getTime() + 11 * 60_000),
        async () => ({ login: 'operator' }),
      ),
    ).rejects.toMatchObject({ code: 'expired_oauth_state' });
  });

  it('rejects callback errors and a login outside the exact allowlist', async () => {
    const request = createAuthorizationRequest(config, now, '/');

    await expect(
      verifyCallback(
        config,
        request.cookie,
        request.state,
        undefined,
        now,
        async () => ({
          login: 'operator',
        }),
        'access_denied',
      ),
    ).rejects.toMatchObject({ code: 'oauth_callback_error' });
    await expect(
      verifyCallback(
        config,
        request.cookie,
        request.state,
        'code',
        now,
        async () => ({
          login: 'Operator',
        }),
      ),
    ).rejects.toMatchObject({ code: 'login_not_allowed' });
  });

  it('expires encrypted sessions and rejects tampering', () => {
    const session = issueSession(config, 'operator', now);

    expect(readSession(config, session, now)).toMatchObject({
      login: 'operator',
    });
    expect(
      readSession(
        config,
        session,
        new Date(now.getTime() + 8 * 60 * 60_000 + 1),
      ),
    ).toBeUndefined();
    expect(
      readSession(config, `${session.slice(0, -1)}x`, now),
    ).toBeUndefined();
  });

  it.each([
    ['https://evil.example', '/'],
    ['//evil.example/path', '/'],
    ['javascript:alert(1)', '/'],
    ['/runs?status=waiting', '/runs?status=waiting'],
  ])('sanitizes redirect %s', (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });

  it('serializes host-only secure cookies', () => {
    expect(secureCookie('__Host-session', 'value', 60)).toBe(
      '__Host-session=value; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('detects localhost origins accurately', () => {
    expect(isLocalhost('http://localhost:3000')).toBe(true);
    expect(isLocalhost('http://127.0.0.1:3107')).toBe(true);
    expect(isLocalhost('http://[::1]:3000')).toBe(true);
    expect(isLocalhost('http://0.0.0.0:8000')).toBe(true);
    expect(isLocalhost('localhost:3000')).toBe(true);
    expect(isLocalhost(new URL('http://localhost:3000'))).toBe(true);
    expect(isLocalhost('https://control.example')).toBe(false);
    expect(isLocalhost('http://example.com')).toBe(false);
    expect(isLocalhost('not-a-valid-url')).toBe(false);
  });

  it('governs localhost bypass permission strictly', () => {
    expect(
      isLocalhostBypassAllowed({
        NODE_ENV: 'production',
        AGENTOS_PUBLIC_URL: 'http://localhost:3000',
      }),
    ).toBe(false);

    expect(
      isLocalhostBypassAllowed({
        NODE_ENV: 'development',
        AGENTOS_PUBLIC_URL: 'http://localhost:3000',
      }),
    ).toBe(true);

    expect(
      isLocalhostBypassAllowed({
        NODE_ENV: 'development',
      }),
    ).toBe(true);

    expect(
      isLocalhostBypassAllowed({
        NODE_ENV: 'development',
        AGENTOS_PUBLIC_URL: 'https://control.example',
      }),
    ).toBe(false);
  });

  it('provides safe zero-config defaults on localhost during development', () => {
    const localConfig = authConfigFromEnv({ NODE_ENV: 'development' });
    expect(localConfig.publicUrl).toBe('http://localhost:3000');
    expect(localConfig.allowedLogin).toBe('operator');
    expect(localConfig.clientId).toBe('local-client');
    expect(localConfig.clientSecret).toBe('local-secret');
    expect(Buffer.byteLength(localConfig.sessionSecret)).toBeGreaterThanOrEqual(
      32,
    );

    const customLocal = authConfigFromEnv({
      NODE_ENV: 'development',
      AGENTOS_PUBLIC_URL: 'http://127.0.0.1:3107',
      GITHUB_ALLOWED_LOGIN: 'custom-operator',
    });
    expect(customLocal.publicUrl).toBe('http://127.0.0.1:3107');
    expect(customLocal.allowedLogin).toBe('custom-operator');
  });

  it('fails closed when production auth configuration is absent or insecure', () => {
    expect(() => authConfigFromEnv({ NODE_ENV: 'production' })).toThrow(
      'AGENTOS_PUBLIC_URL is required',
    );
    expect(() =>
      authConfigFromEnv({
        NODE_ENV: 'production',
        AGENTOS_PUBLIC_URL: 'http://control.example',
      }),
    ).toThrow('must use HTTPS');
    expect(() =>
      authConfigFromEnv({
        NODE_ENV: 'production',
        AGENTOS_PUBLIC_URL: 'not a URL',
      }),
    ).toThrow('AGENTOS_PUBLIC_URL must be an absolute URL');
    expect(() =>
      authConfigFromEnv({
        NODE_ENV: 'production',
        AGENTOS_PUBLIC_URL: 'https://control.example',
      }),
    ).toThrow('AGENTOS_SESSION_SECRET is required');
  });

  it('enforces required credentials on non-localhost origins in development', () => {
    expect(() =>
      authConfigFromEnv({
        NODE_ENV: 'development',
        AGENTOS_PUBLIC_URL: 'https://remote.example',
      }),
    ).toThrow('AGENTOS_SESSION_SECRET is required');
  });
});
