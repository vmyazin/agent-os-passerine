import { NextResponse } from 'next/server';
import { z } from 'zod';

import { AuthError } from '../auth/auth';
import { ServiceError } from '../application/control-plane-service';

const MAX_BODY_BYTES = 64 * 1024;

export interface ApiContract<TBody = unknown> {
  readonly authorize?: () => void;
  readonly body?: z.ZodType<TBody>;
  readonly output?: z.ZodType;
  readonly successStatus?: number;
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
): Promise<T> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) {
    throw new ServiceError(
      'payload_too_large',
      'request body is too large',
      413,
    );
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new ServiceError(
      'payload_too_large',
      'request body is too large',
      413,
    );
  }
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
      ? await parseBody(request, contract.body)
      : (undefined as TBody);
    const output = await handler(body);
    const checked = contract.output?.safeParse(output);
    if (checked && !checked.success) {
      throw new Error('API output contract violation');
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
    return errorResponse('internal_error', 'an unexpected error occurred', 500);
  }
}
