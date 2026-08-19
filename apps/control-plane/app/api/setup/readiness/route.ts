import { NextResponse } from 'next/server';

import { setupReadiness } from '../../../../src/application/setup-readiness';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleApi(
    request,
    { authorize: () => requireApiAuthentication(request) },
    async () => setupReadiness(process.env),
  );
}

export function POST(): Response {
  return NextResponse.json(
    { error: { code: 'method_not_allowed', message: 'only GET is supported' } },
    { status: 405, headers: { allow: 'GET' } },
  );
}
