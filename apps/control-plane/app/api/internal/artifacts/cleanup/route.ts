import { runConfiguredArtifactRetentionCleanup } from '../../../../../src/application/artifact-cleanup-runtime';
import { createArtifactCleanupCronHandler } from '../../../../../src/http/artifact-cleanup-cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return createArtifactCleanupCronHandler({
    secret: process.env.CRON_SECRET ?? '',
    run: runConfiguredArtifactRetentionCleanup,
  })(request);
}
