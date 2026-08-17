import {
  AuthError,
  type AuthConfig,
  readSession,
  safeEqual,
  SESSION_COOKIE,
} from './auth';

function cookieValue(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...parts] = pair.trim().split('=');
    if (key === name) return parts.join('=');
  }
  return undefined;
}

export function enforceBrowserMutationOrigin(
  request: Request,
  publicUrl: string,
): void {
  const expectedOrigin = new URL(publicUrl).origin;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (
    !origin ||
    origin !== expectedOrigin ||
    (fetchSite !== null && fetchSite !== 'same-origin')
  ) {
    throw new AuthError('csrf_rejected', 'cross-origin mutation rejected', 403);
  }
}

export function authenticateApiRequest(
  request: Request,
  config: AuthConfig,
  method: string,
):
  | { readonly kind: 'cli' }
  | { readonly kind: 'session'; readonly login: string } {
  if (method === 'WEBHOOK') {
    throw new AuthError(
      'webhook_signature_required',
      'webhook signature required',
      401,
    );
  }
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    const candidate = authorization.slice(7);
    if (config.cliToken && safeEqual(candidate, config.cliToken))
      return { kind: 'cli' };
    throw new AuthError('invalid_api_token', 'invalid API token');
  }
  const session = readSession(config, cookieValue(request, SESSION_COOKIE));
  if (!session)
    throw new AuthError('authentication_required', 'authentication required');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    enforceBrowserMutationOrigin(request, config.publicUrl);
  }
  return { kind: 'session', login: session.login };
}
