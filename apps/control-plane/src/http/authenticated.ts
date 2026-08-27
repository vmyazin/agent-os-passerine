import { AuthError, authConfigFromEnv } from '../auth/auth';
import { authenticateApiRequest } from '../auth/guard';

export function requireApiAuthentication(request: Request) {
  const config = authConfigFromEnv(process.env);
  return authenticateApiRequest(request, config, request.method);
}

export function requireCliAuthentication(request: Request): void {
  if (requireApiAuthentication(request).kind !== 'cli') {
    throw new AuthError(
      'cli_authentication_required',
      'CLI authentication is required',
      403,
    );
  }
}

export function requireSessionAuthentication(request: Request): {
  readonly kind: 'session';
  readonly login: string;
} {
  const identity = requireApiAuthentication(request);
  if (identity.kind !== 'session') {
    throw new AuthError(
      'session_authentication_required',
      'Browser session authentication is required',
      403,
    );
  }
  return identity;
}
