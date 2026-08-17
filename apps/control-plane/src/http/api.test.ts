import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { handleApi } from './api';
import { AuthError } from '../auth/auth';

describe('API boundary', () => {
  it.each([
    ['missing', undefined],
    ['lying', '2'],
  ])(
    'stops streaming an oversized body with %s Content-Length',
    async (_label, contentLength) => {
      const cancelled: string[] = [];
      const chunk = new Uint8Array(40 * 1024).fill(65);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled.push('cancelled');
        },
      });
      const headers = new Headers({ 'content-type': 'application/json' });
      if (contentLength !== undefined)
        headers.set('content-length', contentLength);

      const response = await handleApi(
        new Request('https://control.example/api/features', {
          method: 'POST',
          headers,
          body,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }),
        { body: z.unknown() },
        async () => ({ ok: true }),
      );

      expect(response.status).toBe(413);
      expect(cancelled).toEqual(['cancelled']);
    },
  );

  it('counts UTF-8 bytes across multibyte stream chunks', async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({ value: '🐦'.repeat(22_000) }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 3) {
          controller.enqueue(encoded.slice(offset, offset + 3));
        }
        controller.close();
      },
    });

    const response = await handleApi(
      new Request('https://control.example/api/features', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      { body: z.unknown() },
      async () => ({ ok: true }),
    );

    expect(response.status).toBe(413);
  });

  it('returns a stable validation envelope without stack traces', async () => {
    const response = await handleApi(
      new Request('https://control.example/api/features', {
        method: 'POST',
        body: JSON.stringify({ title: '' }),
      }),
      { body: z.object({ title: z.string().min(1) }) },
      async () => ({ ok: true }),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'validation_error' } });
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  it('maps missing resources and unexpected errors predictably', async () => {
    const response = await handleApi(
      new Request('https://control.example/api/runs/missing'),
      {},
      async () => {
        throw Object.assign(new Error('missing'), {
          code: 'not_found',
          status: 404,
        });
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'not_found', message: 'missing' },
    });
  });

  it('authenticates before parsing an invalid request body', async () => {
    const response = await handleApi(
      new Request('https://control.example/api/features', {
        method: 'POST',
        body: '{not-json',
      }),
      {
        authorize: () => {
          throw new AuthError(
            'authentication_required',
            'authentication required',
          );
        },
        body: z.object({ title: z.string() }),
      },
      async () => ({ ok: true }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'authentication_required',
        message: 'authentication required',
      },
    });
  });
});
