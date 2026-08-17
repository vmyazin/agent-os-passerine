import { describe, expect, it, vi } from 'vitest';

import { createArtifactCleanupCronHandler } from './artifact-cleanup-cron';

describe('artifact cleanup cron HTTP handler', () => {
  it('requires the exact server-side cron bearer secret', async () => {
    const run = vi.fn(async () => ({ skipped: false }));
    const handler = createArtifactCleanupCronHandler({
      secret: 's'.repeat(32),
      run,
    });
    for (const authorization of [undefined, 'Bearer wrong']) {
      const response = await handler(
        new Request(
          'https://control.agentos.test/api/internal/artifacts/cleanup',
          {
            ...(authorization === undefined
              ? {}
              : { headers: { authorization } }),
          },
        ),
      );
      expect(response.status).toBe(401);
    }
    const accepted = await handler(
      new Request(
        'https://control.agentos.test/api/internal/artifacts/cleanup',
        {
          headers: { authorization: `Bearer ${'s'.repeat(32)}` },
        },
      ),
    );
    expect(accepted.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
