import { NextResponse } from 'next/server';

import {
  authConfigFromEnv,
  clearCookie,
  SESSION_COOKIE,
} from '../../../src/auth/auth';
import { enforceBrowserMutationOrigin } from '../../../src/auth/guard';

export function POST(request: Request): Response {
  const config = authConfigFromEnv(process.env);
  enforceBrowserMutationOrigin(request, config.publicUrl);
  const response = NextResponse.redirect(
    new URL('/login', config.publicUrl),
    303,
  );
  response.headers.append('Set-Cookie', clearCookie(SESSION_COOKIE));
  return response;
}
