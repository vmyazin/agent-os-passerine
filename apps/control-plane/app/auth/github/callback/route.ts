import { NextResponse } from 'next/server';

import {
  authConfigFromEnv,
  clearCookie,
  OAUTH_COOKIE,
  secureCookie,
  SESSION_COOKIE,
  verifyCallback,
} from '../../../../src/auth/auth';
import { exchangeGitHubCode } from '../../../../src/auth/github';

export const dynamic = 'force-dynamic';

function cookie(request: Request, name: string): string | undefined {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((item) => item.trim().split('='))
    .find(([key]) => key === name)
    ?.slice(1)
    .join('=');
}

export async function GET(request: Request): Promise<Response> {
  const config = authConfigFromEnv(process.env);
  const parameters = new URL(request.url).searchParams;
  try {
    const result = await verifyCallback(
      config,
      cookie(request, OAUTH_COOKIE),
      parameters.get('state') ?? undefined,
      parameters.get('code') ?? undefined,
      new Date(),
      (code, verifier) => exchangeGitHubCode(config, code, verifier),
      parameters.get('error') ?? undefined,
    );
    const response = NextResponse.redirect(
      new URL(result.returnTo, config.publicUrl),
    );
    response.headers.append('Set-Cookie', clearCookie(OAUTH_COOKIE));
    response.headers.append(
      'Set-Cookie',
      secureCookie(SESSION_COOKIE, result.session, 8 * 60 * 60),
    );
    return response;
  } catch {
    const response = NextResponse.redirect(
      new URL('/login?error=oauth', config.publicUrl),
    );
    response.headers.append('Set-Cookie', clearCookie(OAUTH_COOKIE));
    response.headers.append('Set-Cookie', clearCookie(SESSION_COOKIE));
    return response;
  }
}
