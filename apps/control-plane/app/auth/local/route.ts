import { NextResponse } from 'next/server';

import {
  authConfigFromEnv,
  clearCookie,
  isLocalhostBypassAllowed,
  issueSession,
  OAUTH_COOKIE,
  sanitizeReturnTo,
  secureCookie,
  SESSION_COOKIE,
} from '../../../src/auth/auth';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  if (!isLocalhostBypassAllowed(process.env)) {
    return new Response(
      'Local login bypass is only allowed on localhost in non-production environments.',
      { status: 403 },
    );
  }

  const config = authConfigFromEnv(process.env);
  const returnTo = sanitizeReturnTo(
    new URL(request.url).searchParams.get('returnTo'),
  );
  const session = issueSession(config, config.allowedLogin, new Date());
  const response = NextResponse.redirect(new URL(returnTo, config.publicUrl));
  response.headers.append('Set-Cookie', clearCookie(OAUTH_COOKIE));
  response.headers.append(
    'Set-Cookie',
    secureCookie(SESSION_COOKIE, session, 8 * 60 * 60),
  );
  return response;
}

export async function POST(request: Request): Promise<Response> {
  if (!isLocalhostBypassAllowed(process.env)) {
    return new Response(
      'Local login bypass is only allowed on localhost in non-production environments.',
      { status: 403 },
    );
  }

  const config = authConfigFromEnv(process.env);
  let requestedReturnTo: string | null = new URL(request.url).searchParams.get(
    'returnTo',
  );

  if (!requestedReturnTo) {
    try {
      const formData = await request.formData();
      const value = formData.get('returnTo');
      if (typeof value === 'string') {
        requestedReturnTo = value;
      }
    } catch {
      // Content-type may not be form-data, ignore
    }
  }

  const returnTo = sanitizeReturnTo(requestedReturnTo);
  const session = issueSession(config, config.allowedLogin, new Date());
  const response = NextResponse.redirect(
    new URL(returnTo, config.publicUrl),
    303,
  );
  response.headers.append('Set-Cookie', clearCookie(OAUTH_COOKIE));
  response.headers.append(
    'Set-Cookie',
    secureCookie(SESSION_COOKIE, session, 8 * 60 * 60),
  );
  return response;
}
