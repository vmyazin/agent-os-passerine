import { describe, expect, it, vi } from 'vitest';

import { ApiClient, MAX_RESPONSE_BYTES } from './api-client.js';

describe('ApiClient', () => {
  it('requires HTTPS outside localhost and authentication', () => {
    expect(
      () => new ApiClient({ url: 'http://control.example', token: 'x' }),
    ).toThrow('HTTPS');
    expect(
      () => new ApiClient({ url: 'https://control.example', token: '' }),
    ).toThrow('API token');
    expect(
      () => new ApiClient({ url: 'http://localhost:3000', token: 'x' }),
    ).not.toThrow();
  });

  it('sends bearer auth and idempotency headers without retrying mutations', async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer secret-token',
        );
        expect(new Headers(init?.headers).get('idempotency-key')).toBe('key-1');
        return new Response(JSON.stringify({ id: 'run_1' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    const client = new ApiClient({
      url: 'https://control.example',
      token: 'secret-token',
      fetch,
    });

    await expect(
      client.request('POST', '/api/features', { title: 'Ship' }, 'key-1'),
    ).resolves.toEqual({ id: 'run_1' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('times out, bounds streamed responses, and redacts credentials from errors', async () => {
    const timeoutClient = new ApiClient({
      url: 'https://control.example',
      token: 'timeout-secret',
      timeoutMs: 5,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    });
    await expect(timeoutClient.request('GET', '/api/runs')).rejects.toThrow(
      'timed out',
    );

    const oversizeClient = new ApiClient({
      url: 'https://control.example',
      token: 'oversize-secret',
      fetch: async () =>
        new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(oversizeClient.request('GET', '/api/runs')).rejects.toThrow(
      'too large',
    );

    const errorClient = new ApiClient({
      url: 'https://control.example',
      token: 'never-print-this-token',
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'bad_request',
              message: 'Bearer never-print-this-token was rejected',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    });
    try {
      await errorClient.request('GET', '/api/runs');
      throw new Error('expected request to fail');
    } catch (error) {
      expect(String(error)).toContain('[REDACTED]');
      expect(String(error)).not.toContain('never-print-this-token');
    }
  });
});
