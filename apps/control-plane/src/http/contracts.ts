import { z } from 'zod';

const digest = z.string().trim().min(1).max(256);
const id = z.string().trim().min(1).max(128);

export const createRunSchema = z
  .object({
    projectId: id,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(10_000),
    repositorySha: z.string().regex(/^[a-f0-9]{40}$/i),
    configDigest: digest,
    modelDigest: digest,
    promptDigest: digest,
    environmentDigest: digest,
    policyDigest: digest,
  })
  .strict();

export const emptyMutationSchema = z.object({}).strict();
export const approvalDecisionSchema = z.object({}).strict();
export const inboxReplySchema = z
  .object({
    reply: z.union([
      z.string().trim().min(1).max(10_000),
      z.record(z.string(), z.unknown()),
    ]),
  })
  .strict();

export const runProjectionSchema = z
  .object({
    id: id,
    projectId: id,
    pipeline: z.string(),
    status: z.enum([
      'pending',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'cancelled',
    ]),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    repositorySha: z.string(),
    configDigest: z.string(),
    modelDigest: z.string(),
    promptDigest: z.string(),
    environmentDigest: z.string(),
    policyDigest: z.string(),
    steps: z.array(
      z
        .object({
          id: id,
          stepKey: z.string(),
          attempt: z.number(),
          status: z.string(),
        })
        .strict(),
    ),
    timeline: z.array(
      z
        .object({
          eventId: id,
          sequence: z.number(),
          type: z.string(),
          payload: z.unknown().optional(),
          occurredAt: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const approvalSchema = z
  .object({
    id,
    runId: id,
    scope: z.string(),
    fingerprint: z.string(),
    status: z.enum(['pending', 'consumed', 'expired']),
    createdAt: z.string(),
    expiresAt: z.string(),
    consumedAt: z.string().optional(),
  })
  .strict();

export const inboxMessageSchema = z
  .object({
    id,
    runId: id,
    stepRunId: id.optional(),
    status: z.enum(['pending', 'replied']),
    body: z.unknown(),
    reply: z.unknown().optional(),
    createdAt: z.string(),
    repliedAt: z.string().optional(),
  })
  .strict();

export function idempotencyKey(request: Request): string {
  const key = request.headers.get('idempotency-key')?.trim();
  if (!key || key.length > 200) {
    throw Object.assign(new Error('Idempotency-Key header is required'), {
      code: 'idempotency_key_required',
      status: 400,
    });
  }
  return key;
}

export function boundedPathId(value: string): string {
  const parsed = id.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error('path identifier is invalid'), {
      code: 'validation_error',
      status: 422,
    });
  }
  return parsed.data;
}

export function assertNoQuery(request: Request): void {
  if ([...new URL(request.url).searchParams].length !== 0) {
    throw Object.assign(new Error('query parameters are not supported'), {
      code: 'validation_error',
      status: 422,
    });
  }
}
