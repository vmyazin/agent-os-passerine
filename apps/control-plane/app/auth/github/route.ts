import { NextResponse } from 'next/server';

import {
  authConfigFromEnv,
  createAuthorizationRequest,
  OAUTH_COOKIE,
  secureCookie,
} from '../../../src/auth/auth';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  const config = authConfigFromEnv(process.env);
  const returnTo = new URL(request.url).searchParams.get('returnTo') ?? '/';
  const authorization = createAuthorizationRequest(
    config,
    new Date(),
    returnTo,
  );
  const response = NextResponse.redirect(authorization.url);
  response.headers.append(
    'Set-Cookie',
    secureCookie(OAUTH_COOKIE, authorization.cookie, 10 * 60),
  );
  return response;
}
