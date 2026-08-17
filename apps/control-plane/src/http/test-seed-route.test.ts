import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../../app/api/test/seed/route';

describe('test seed route production boundary', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns 404 in production even when seeding is enabled and CLI auth is valid', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AGENTOS_E2E_SEED', 'enabled');
    vi.stubEnv('AGENTOS_API_TOKEN', 'valid-test-token');

    const response = await POST(
      new Request('https://control.example/api/test/seed', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-test-token',
          origin: 'https://control.example',
        },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'not_found', message: 'not found' },
    });
  });
});
