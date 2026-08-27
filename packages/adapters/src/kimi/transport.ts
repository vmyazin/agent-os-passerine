import { z } from 'zod';

import {
  KimiTransportError,
  type KimiContentBlock,
  type KimiTransport,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/anthropic';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_ERROR_BODY_CHARS = 500;
const RETRY_DELAY_MS = 1000;
const RETRYABLE_STATUS = (status: number): boolean =>
  status === 429 || (status >= 500 && status < 600);

const contentBlockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
    })
    .strict(),
  // Current Kimi models are reasoning models and emit thinking blocks on
  // the Anthropic-compatible endpoint. The block may carry extra fields
  // (e.g. a signature), so it alone is not strict; unknown block TYPES
  // still fail closed via the discriminated union.
  z
    .object({
      type: z.literal('thinking'),
      thinking: z.string(),
      signature: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_use'),
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_result'),
      tool_use_id: z.string(),
      content: z.string(),
      is_error: z.boolean().optional(),
    })
    .strict(),
]);

// The outer envelope and usage object are intentionally NOT `.strict()`:
// real Anthropic-compatible Messages responses carry additional fields
// (id, type, role, model, stop_sequence, container, cache token counts,
// etc.) that this transport doesn't need. Fail-closed validation is scoped
// to the content-block union above, where an unrecognized block type is a
// genuine protocol violation worth rejecting.
const responseSchema = z.object({
  content: z.array(contentBlockSchema),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

export interface CreateKimiHttpTransportOptions {
  readonly apiKey: string;
  readonly baseUrl?: string; // default https://api.moonshot.ai/anthropic
  readonly fetchImpl?: typeof fetch;
}

export function createKimiHttpTransport(
  options: CreateKimiHttpTransportOptions,
): KimiTransport {
  if (options.apiKey.trim().length === 0) {
    throw new Error('apiKey is required');
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;

  const transport: KimiTransport = {
    async send(request, sendOptions) {
      const body = JSON.stringify({
        model: request.model,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: request.messages,
        tools: request.tools,
        max_tokens: request.maxTokens,
      });
      const response = await sendWithRetry(
        fetchImpl,
        `${baseUrl}/v1/messages`,
        options.apiKey,
        body,
        sendOptions?.signal,
      );
      if (!response.ok) {
        const text = await response.text();
        throw new KimiTransportError(
          response.status,
          text.slice(0, MAX_ERROR_BODY_CHARS),
        );
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // A 2xx response with no complete JSON envelope is an upstream
        // transport failure, not a permanent model-contract violation.
        // Report it as 502 so the workflow's bounded retry policy applies.
        throw new KimiTransportError(502, 'invalid JSON response from Kimi');
      }
      const parsed = responseSchema.parse(json);
      return Object.freeze({
        content: Object.freeze(parsed.content.map(toContentBlock)),
        stopReason: parsed.stop_reason,
        usage: Object.freeze({
          inputTokens: parsed.usage.input_tokens,
          outputTokens: parsed.usage.output_tokens,
        }),
      });
    },
  };
  return Object.freeze(transport);
}

function toContentBlock(
  block: z.infer<typeof contentBlockSchema>,
): KimiContentBlock {
  if (block.type === 'text') {
    return Object.freeze({ type: 'text', text: block.text });
  }
  if (block.type === 'tool_use') {
    return Object.freeze({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    });
  }
  if (block.type === 'thinking') {
    return Object.freeze({ type: 'thinking', thinking: block.thinking });
  }
  return Object.freeze({
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: block.content,
    ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
  });
}

async function sendWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  body: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const init: RequestInit = {
    method: 'POST',
    headers,
    body,
    ...(signal === undefined ? {} : { signal }),
  };
  const first = await fetchImpl(url, init);
  if (first.ok || !RETRYABLE_STATUS(first.status)) return first;
  await sleep(RETRY_DELAY_MS);
  // A session cancelled during the retry delay must not spend another
  // request; the caller sees the same abort rejection it would have seen
  // mid-flight.
  signal?.throwIfAborted();
  return fetchImpl(url, init);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
