import { artifactMcpHandler } from '../../../../src/application/artifact-mcp-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return artifactMcpHandler()(request);
}

export function GET(): Response {
  return Response.json(
    {
      error: { code: 'method_not_allowed', message: 'only POST is supported' },
    },
    { status: 405, headers: { allow: 'POST' } },
  );
}
