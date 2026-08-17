import {
  MAX_CANONICAL_CONFIG_BYTES,
  MAX_CONFIGURATION_APPLY_BODY_BYTES,
} from '@agentos/core';

import { CliError } from './args.js';

export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_CONFIGURATION_REQUEST_BYTES =
  MAX_CONFIGURATION_APPLY_BODY_BYTES;
const DEFAULT_TIMEOUT_MS = 15_000;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const REMOTE_CODES = new Set([
  'approval_already_decided',
  'approval_expired',
  'approval_invalid',
  'approval_scope_mismatch',
  'authentication_required',
  'cli_authentication_required',
  'configuration_digest_mismatch',
  'configuration_invalid',
  'configuration_not_canonical',
  'configuration_stale',
  'idempotency_conflict',
  'idempotency_key_required',
  'invalid_api_token',
  'invalid_json',
  'invalid_state',
  'not_found',
  'payload_too_large',
  'validation_error',
]);

export class ApiError extends CliError {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message, status === 401 || status === 403 ? 4 : 3);
    this.name = 'ApiError';
  }
}

class RequestValidationError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export interface ApiClientOptions {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

function redact(value: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value
    .replace(new RegExp(escaped, 'g'), '[REDACTED]')
    .replace(/\b(Basic|Bearer)\s+[^\s,;"']+/gi, '$1 [REDACTED]')
    .replace(
      /\b((?:x-)?api[_-]?key|access[_-]?token|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/([?&](?:token|api[_-]?key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
}

function remoteCode(value: unknown): string {
  return typeof value === 'string' && REMOTE_CODES.has(value)
    ? value
    : 'remote_error';
}

function checkedBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError('Agent OS URL must be an absolute URL');
  }
  const localhost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
    throw new CliError('Agent OS URL must use HTTPS outside localhost');
  }
  if (url.username || url.password) {
    throw new CliError('Agent OS URL must not contain credentials');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ApiError('server response is too large');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ApiError('server response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf8', { fatal: true }).decode(joined);
}

export class ApiClient {
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = checkedBaseUrl(options.url);
    this.#token = options.token;
    if (!this.#token) throw new CliError('Agent OS API token is required');
    if (!BEARER_TOKEN.test(this.#token))
      throw new CliError('Agent OS API token is invalid');
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 120_000
    ) {
      throw new CliError('request timeout is invalid');
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    if (
      url.origin !== this.#baseUrl.origin ||
      !url.pathname.startsWith('/api/')
    ) {
      throw new CliError('API path is invalid');
    }
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      let serializedBody: string | undefined;
      if (body !== undefined) {
        serializedBody = JSON.stringify(body);
        if (serializedBody === undefined)
          throw new RequestValidationError(
            'request body is not JSON serializable',
          );
        if (url.pathname === '/api/configuration/apply') {
          const serializedValue = JSON.parse(serializedBody) as unknown;
          const canonicalConfig =
            typeof serializedValue === 'object' && serializedValue !== null
              ? (serializedValue as Record<string, unknown>).canonicalConfig
              : undefined;
          if (
            typeof canonicalConfig === 'string' &&
            new TextEncoder().encode(canonicalConfig).byteLength >
              MAX_CANONICAL_CONFIG_BYTES
          ) {
            throw new RequestValidationError(
              `canonical configuration is too large (maximum ${MAX_CANONICAL_CONFIG_BYTES} bytes)`,
            );
          }
        }
        const limit =
          url.pathname === '/api/configuration/apply'
            ? MAX_CONFIGURATION_REQUEST_BYTES
            : MAX_REQUEST_BYTES;
        if (new TextEncoder().encode(serializedBody).byteLength > limit)
          throw new RequestValidationError('request body is too large');
      }
      const headers = new Headers({
        accept: 'application/json',
        authorization: `Bearer ${this.#token}`,
      });
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (idempotencyKey !== undefined)
        headers.set('idempotency-key', idempotencyKey);
      response = await this.#fetch(url, {
        method,
        headers,
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
        signal,
      });
    } catch (error) {
      if (error instanceof RequestValidationError) throw error;
      if (signal.aborted) throw new ApiError('request timed out');
      const message = error instanceof Error ? error.message : 'request failed';
      throw new ApiError(redact(message, this.#token));
    }
    let text: string;
    try {
      text = await boundedText(response);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('server returned an unreadable response');
    }
    let parsed: unknown;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      throw new ApiError('server returned invalid JSON', response.status);
    }
    if (!response.ok) {
      const envelope = parsed as {
        error?: { code?: unknown; message?: unknown };
      } | null;
      const code = remoteCode(envelope?.error?.code);
      const message =
        typeof envelope?.error?.message === 'string'
          ? envelope.error.message
          : `request failed with HTTP ${response.status}`;
      throw new ApiError(redact(message, this.#token), response.status, code);
    }
    return parsed;
  }
}
