import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const OAUTH_COOKIE = '__Host-agentos-oauth';
export const SESSION_COOKIE = '__Host-agentos-session';
const OAUTH_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;

export interface AuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly allowedLogin: string;
  readonly publicUrl: string;
  readonly sessionSecret: string;
  readonly cliToken?: string;
}

export type AuthEnvironment = Partial<Record<string, string | undefined>>;

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export const DEFAULT_LOCAL_DEV_SESSION_SECRET =
  'agentos-local-development-session-secret-32b';

export function isLocalhost(urlOrHost: string | URL): boolean {
  try {
    let hostname: string;
    if (typeof urlOrHost === 'string') {
      const candidate = urlOrHost.trim();
      if (!candidate) return false;
      const url = candidate.includes('://')
        ? new URL(candidate)
        : new URL(`http://${candidate}`);
      hostname = url.hostname;
    } else {
      hostname = urlOrHost.hostname;
    }
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      normalized === 'localhost' ||
      normalized === '127.0.0.1' ||
      normalized === '::1' ||
      normalized === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

export function isLocalhostBypassAllowed(
  environment: AuthEnvironment = process.env,
): boolean {
  if (environment.NODE_ENV === 'production') return false;
  const publicUrl =
    environment.AGENTOS_PUBLIC_URL?.trim() || 'http://localhost:3000';
  return isLocalhost(publicUrl);
}

function required(environment: AuthEnvironment, key: string): string {
  const value = environment[key]?.trim();
  if (!value)
    throw new AuthError('auth_not_configured', `${key} is required`, 503);
  return value;
}

export function authConfigFromEnv(environment: AuthEnvironment): AuthConfig {
  const isProd = environment.NODE_ENV === 'production';
  const rawPublicUrl = environment.AGENTOS_PUBLIC_URL?.trim();

  if (isProd && !rawPublicUrl) {
    throw new AuthError(
      'auth_not_configured',
      'AGENTOS_PUBLIC_URL is required',
      503,
    );
  }

  const publicUrl = rawPublicUrl || (isProd ? '' : 'http://localhost:3000');
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new AuthError(
      'auth_not_configured',
      'AGENTOS_PUBLIC_URL must be an absolute URL',
      503,
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AuthError(
      'auth_not_configured',
      'AGENTOS_PUBLIC_URL must use HTTP or HTTPS',
      503,
    );
  }
  if (isProd && parsed.protocol !== 'https:') {
    throw new AuthError(
      'auth_not_configured',
      'AGENTOS_PUBLIC_URL must use HTTPS in production',
      503,
    );
  }

  const localBypass = !isProd && isLocalhost(parsed);

  let sessionSecret: string;
  const providedSessionSecret = environment.AGENTOS_SESSION_SECRET?.trim();
  if (localBypass && !providedSessionSecret) {
    sessionSecret = DEFAULT_LOCAL_DEV_SESSION_SECRET;
  } else {
    sessionSecret = required(environment, 'AGENTOS_SESSION_SECRET');
    if (Buffer.byteLength(sessionSecret) < 32) {
      throw new AuthError(
        'auth_not_configured',
        'AGENTOS_SESSION_SECRET must be at least 32 bytes',
        503,
      );
    }
  }

  const cliToken = environment.AGENTOS_CLI_TOKEN?.trim();

  const clientId = localBypass
    ? environment.GITHUB_CLIENT_ID?.trim() || 'local-client'
    : required(environment, 'GITHUB_CLIENT_ID');

  const clientSecret = localBypass
    ? environment.GITHUB_CLIENT_SECRET?.trim() || 'local-secret'
    : required(environment, 'GITHUB_CLIENT_SECRET');

  const allowedLogin = localBypass
    ? environment.GITHUB_ALLOWED_LOGIN?.trim() || 'operator'
    : required(environment, 'GITHUB_ALLOWED_LOGIN');

  return {
    clientId,
    clientSecret,
    allowedLogin,
    publicUrl: parsed.origin,
    sessionSecret,
    ...(cliToken ? { cliToken } : {}),
  };
}

function encoded(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function key(config: AuthConfig): Buffer {
  return createHash('sha256').update(config.sessionSecret).digest();
}

function seal(config: AuthConfig, value: object): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(config), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return [
    encoded(nonce),
    encoded(ciphertext),
    encoded(cipher.getAuthTag()),
  ].join('.');
}

function open<T>(config: AuthConfig, value: string): T | undefined {
  try {
    const parts = value.split('.');
    if (parts.length !== 3) return undefined;
    const nonce = Buffer.from(parts[0] ?? '', 'base64url');
    const ciphertext = Buffer.from(parts[1] ?? '', 'base64url');
    const tag = Buffer.from(parts[2] ?? '', 'base64url');
    if (
      nonce.length !== 12 ||
      tag.length !== 16 ||
      encoded(nonce) !== parts[0] ||
      encoded(ciphertext) !== parts[1] ||
      encoded(tag) !== parts[2]
    )
      return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key(config), nonce);
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        'utf8',
      ),
    ) as T;
  } catch {
    return undefined;
  }
}

export function secureCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return secureCookie(name, '', 0);
}

export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://local.invalid');
    return url.origin === 'https://local.invalid'
      ? `${url.pathname}${url.search}${url.hash}`
      : '/';
  } catch {
    return '/';
  }
}

interface OAuthState {
  readonly state: string;
  readonly verifier: string;
  readonly returnTo: string;
  readonly issuedAt: number;
}

export function createAuthorizationRequest(
  config: AuthConfig,
  now: Date,
  requestedReturnTo?: string,
): {
  readonly url: URL;
  readonly cookie: string;
  readonly state: string;
} {
  const state = encoded(randomBytes(32));
  const verifier = encoded(randomBytes(48));
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set(
    'redirect_uri',
    `${config.publicUrl}/auth/github/callback`,
  );
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('state', state);
  url.searchParams.set(
    'code_challenge',
    encoded(createHash('sha256').update(verifier).digest()),
  );
  url.searchParams.set('code_challenge_method', 'S256');
  return {
    url,
    cookie: seal(config, {
      state,
      verifier,
      returnTo: sanitizeReturnTo(requestedReturnTo),
      issuedAt: now.getTime(),
    } satisfies OAuthState),
    state,
  };
}

interface GitHubIdentity {
  readonly login: string;
}

export async function verifyCallback(
  config: AuthConfig,
  stateCookie: string | undefined,
  callbackState: string | undefined,
  code: string | undefined,
  now: Date,
  exchange: (code: string, verifier: string) => Promise<GitHubIdentity>,
  callbackError?: string,
): Promise<{
  readonly login: string;
  readonly returnTo: string;
  readonly session: string;
}> {
  if (callbackError || !code) {
    throw new AuthError('oauth_callback_error', 'GitHub authorization failed');
  }
  const state = stateCookie ? open<OAuthState>(config, stateCookie) : undefined;
  if (!state || !callbackState || !safeEqual(state.state, callbackState)) {
    throw new AuthError('invalid_oauth_state', 'OAuth state did not match');
  }
  if (now.getTime() - state.issuedAt > OAUTH_TTL_MS) {
    throw new AuthError('expired_oauth_state', 'OAuth state expired');
  }
  const identity = await exchange(code, state.verifier);
  if (identity.login !== config.allowedLogin) {
    throw new AuthError(
      'login_not_allowed',
      'GitHub login is not allowed',
      403,
    );
  }
  return {
    login: identity.login,
    returnTo: sanitizeReturnTo(state.returnTo),
    session: issueSession(config, identity.login, now),
  };
}

interface SessionClaims {
  readonly login: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export function issueSession(
  config: AuthConfig,
  login: string,
  now: Date,
): string {
  return seal(config, {
    login,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + SESSION_TTL_MS,
  } satisfies SessionClaims);
}

export function readSession(
  config: AuthConfig,
  value: string | undefined,
  now = new Date(),
): SessionClaims | undefined {
  if (!value) return undefined;
  const claims = open<SessionClaims>(config, value);
  if (
    !claims ||
    claims.login !== config.allowedLogin ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= now.getTime()
  ) {
    return undefined;
  }
  return claims;
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
