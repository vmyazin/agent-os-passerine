import { describe, expect, it, vi } from 'vitest';

import {
  MAX_CANONICAL_CONFIG_BYTES,
  MAX_CONFIGURATION_APPLY_BODY_BYTES,
} from '@agentos/core';

import { ApiClient, MAX_RESPONSE_BYTES } from './api-client.js';

const MAX_REQUEST_BYTES = 64 * 1024;

function bodyWithSerializedSize(size: number): { value: string } {
  const empty = { value: '' };
  const baseSize = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
  const remaining = size - baseSize;
  if (remaining < 0 || remaining % 2 !== 0)
    throw new Error(`cannot construct a body with ${size} encoded bytes`);

  return {
    value:
      '\u00e9"\n'.repeat(Math.floor(remaining / 6)) +
      '\u00e9'.repeat((remaining % 6) / 2),
  };
}

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

  it.each([
    ' leading-token',
    'trailing-token ',
    'two words',
    'tab\ttoken',
    'line\nbreak',
    'carriage\rreturn',
    'control\u0000token',
    'non-ascii-\u00e9',
    'punctuation!token',
    'padding=inside',
  ])('rejects an invalid bearer token before making a request: %j', (token) => {
    const fetch = vi.fn();

    expect(
      () =>
        new ApiClient({
          url: 'https://control.example',
          token,
          fetch,
        }),
    ).toThrow('API token is invalid');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts the token when header construction fails', async () => {
    const token = 'header-secret-token';
    vi.stubGlobal(
      'Headers',
      class {
        constructor() {
          throw new TypeError(`invalid header contained Bearer ${token}`);
        }
      },
    );
    const client = new ApiClient({
      url: 'https://control.example',
      token,
      fetch: vi.fn(),
    });

    try {
      await client.request('GET', '/api/runs');
      throw new Error('expected request to fail');
    } catch (error) {
      expect(String(error)).toContain('[REDACTED]');
      expect(String(error)).not.toContain(token);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it.each([
    ['/api/features', MAX_REQUEST_BYTES],
    ['/api/configuration/apply', MAX_CONFIGURATION_APPLY_BODY_BYTES],
  ] as const)(
    'enforces the exact UTF-8 JSON request ceiling for %s',
    async (path, limit) => {
      const fetch = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) => {
          expect(new TextEncoder().encode(String(init?.body)).byteLength).toBe(
            limit,
          );
          return Response.json({ ok: true });
        },
      );
      const client = new ApiClient({
        url: 'https://control.example',
        token: 'secret-token',
        fetch,
      });
      const exactBody = bodyWithSerializedSize(limit);
      expect(exactBody.value).toContain('"');
      expect(exactBody.value).toContain('\n');
      expect(exactBody.value).toContain('\u00e9');

      await expect(client.request('POST', path, exactBody)).resolves.toEqual({
        ok: true,
      });

      const oversizedFetch = vi.fn();
      const oversizedClient = new ApiClient({
        url: 'https://control.example',
        token: 'secret-token',
        fetch: oversizedFetch,
      });
      await expect(
        oversizedClient.request('POST', path, {
          value: `${exactBody.value}a`,
        }),
      ).rejects.toThrow('request body is too large');
      expect(oversizedFetch).not.toHaveBeenCalled();
    },
  );

  it('enforces the canonical configuration ceiling before making an apply request', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const client = new ApiClient({
      url: 'https://control.example',
      token: 'secret-token',
      fetch,
    });
    const exactCanonical = `"${'é'.repeat(
      (MAX_CANONICAL_CONFIG_BYTES - 2) / 2,
    )}"`;
    expect(new TextEncoder().encode(exactCanonical).byteLength).toBe(
      MAX_CANONICAL_CONFIG_BYTES,
    );
    const requestBody = {
      canonicalConfig: exactCanonical,
      digest: 'a'.repeat(64),
      expectedRevision: null,
      expectedDigest: null,
    };
    expect(
      new TextEncoder().encode(JSON.stringify(requestBody)).byteLength,
    ).toBeLessThan(MAX_CONFIGURATION_APPLY_BODY_BYTES);

    await expect(
      client.request('POST', '/api/configuration/apply', requestBody),
    ).resolves.toEqual({ ok: true });

    await expect(
      client.request('POST', '/api/configuration/apply', {
        ...requestBody,
        canonicalConfig: `${exactCanonical}a`,
      }),
    ).rejects.toThrow(
      `canonical configuration is too large (maximum ${MAX_CANONICAL_CONFIG_BYTES} bytes)`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serializes a request body exactly once', async () => {
    const toJSON = vi.fn(() => ({ value: 'payload' }));
    const client = new ApiClient({
      url: 'https://control.example',
      token: 'secret-token',
      fetch: async (_url, init) => {
        expect(init?.body).toBe('{"value":"payload"}');
        return Response.json({ ok: true });
      },
    });

    await client.request('POST', '/api/features', { toJSON });

    expect(toJSON).toHaveBeenCalledTimes(1);
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

  it('normalizes untrusted remote error codes before exposing them', async () => {
    const client = new ApiClient({
      url: 'https://control.example',
      token: 'local-token',
      fetch: async () =>
        Response.json(
          {
            error: {
              code: 'Bearer stolen-server-token',
              message: 'api_key=remote-secret',
              details: ['token=another-secret'],
            },
          },
          { status: 500 },
        ),
    });

    await expect(client.request('GET', '/api/runs')).rejects.toMatchObject({
      code: 'remote_error',
      message: expect.not.stringContaining('stolen-server-token'),
    });
  });

  it('preserves the stable configuration stale conflict code', async () => {
    const client = new ApiClient({
      url: 'https://control.example',
      token: 'local-token',
      fetch: async () =>
        Response.json(
          {
            error: {
              code: 'configuration_stale',
              message: 'active configuration changed; plan and apply again',
            },
          },
          { status: 409 },
        ),
    });

    await expect(
      client.request('GET', '/api/configuration'),
    ).rejects.toMatchObject({
      code: 'configuration_stale',
      status: 409,
    });
  });
});
