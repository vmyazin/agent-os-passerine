import { createHash, timingSafeEqual } from 'node:crypto';

export interface ArtifactCleanupCronHandlerOptions {
  readonly secret: string;
  readonly run: () => Promise<unknown>;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function createArtifactCleanupCronHandler(
  options: ArtifactCleanupCronHandlerOptions,
): (request: Request) => Promise<Response> {
  if (
    Buffer.byteLength(options.secret, 'utf8') < 32 ||
    Buffer.byteLength(options.secret, 'utf8') > 256
  )
    throw new Error('CRON_SECRET must contain 32 to 256 bytes');
  const expected = digest(`Bearer ${options.secret}`);
  return async (request: Request): Promise<Response> => {
    const supplied = request.headers.get('authorization') ?? '';
    if (!timingSafeEqual(digest(supplied), expected))
      return Response.json(
        { error: { code: 'authentication_required' } },
        { status: 401, headers: { 'cache-control': 'no-store' } },
      );
    const result = await options.run();
    return Response.json(result, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  };
}
