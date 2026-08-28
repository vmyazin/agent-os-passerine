import { NextResponse } from 'next/server';
import { z } from 'zod';

import { MAX_CONFIGURATION_APPLY_BODY_BYTES } from '@agentos/core';

import { AuthError } from '../auth/auth';
import { ServiceError } from '../application/control-plane-service';

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_CONFIG_APPLY_BODY_BYTES = MAX_CONFIGURATION_APPLY_BODY_BYTES;

export interface ApiContract<TBody = unknown> {
  readonly authorize?: () => void;
  readonly body?: z.ZodType<TBody>;
  readonly output?: z.ZodType;
  readonly successStatus?: number;
  readonly maxBodyBytes?: number;
}

function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBodyBytes: number,
): Promise<T> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > maxBodyBytes) {
    await request.body?.cancel();
    throw new ServiceError(
      'payload_too_large',
      'request body is too large',
      413,
    );
  }
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const reader = request.body?.getReader();
  if (reader !== undefined) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxBodyBytes) {
          await reader.cancel();
          throw new ServiceError(
            'payload_too_large',
            'request body is too large',
            413,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ServiceError(
      'invalid_json',
      'request body must be valid JSON',
      400,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ServiceError(
      'validation_error',
      'request did not match the schema',
      422,
    );
  }
  return parsed.data;
}

export async function handleApi<TBody = unknown>(
  request: Request,
  contract: ApiContract<TBody>,
  handler: (body: TBody) => Promise<unknown>,
): Promise<Response> {
  try {
    contract.authorize?.();
    const body = contract.body
      ? await parseBody(
          request,
          contract.body,
          contract.maxBodyBytes ?? MAX_BODY_BYTES,
        )
      : (undefined as TBody);
    const output = await handler(body);
    const checked = contract.output?.safeParse(output);
    if (checked && !checked.success) {
      // The field paths, never their values: a response that fails its own
      // contract is a bug in this service, and naming the fields is the
      // difference between a fixable report and an anonymous 500. Values are
      // withheld because they are exactly the data the contract guards.
      throw new Error(
        `API output contract violation: ${[
          ...new Set(
            checked.error.issues.map((issue) => {
              const path = issue.path
                .map((part) => (typeof part === 'number' ? '#' : String(part)))
                .join('.');
              const keys = (issue as { keys?: readonly string[] }).keys;
              return `${path || '<root>'}[${issue.code}${
                keys === undefined ? '' : `:${keys.join('|')}`
              }]`;
            }),
          ),
        ]
          .slice(0, 20)
          .join(', ')}`,
      );
    }
    return NextResponse.json(checked?.data ?? output, {
      status: contract.successStatus ?? 200,
    });
  } catch (error) {
    if (error instanceof AuthError || error instanceof ServiceError) {
      return errorResponse(error.code, error.message, error.status);
    }
    if (
      error instanceof Error &&
      typeof (error as Error & { code?: unknown }).code === 'string' &&
      typeof (error as Error & { status?: unknown }).status === 'number'
    ) {
      const known = error as Error & { code: string; status: number };
      return errorResponse(known.code, known.message, known.status);
    }
    if (
      error instanceof Error &&
      error.message.startsWith('API output contract violation')
    )
      return errorResponse('internal_error', error.message, 500);
    return errorResponse('internal_error', 'an unexpected error occurred', 500);
  }
}
