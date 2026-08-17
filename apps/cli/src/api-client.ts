import { CliError } from './args.js';

export const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

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
    .replace(/([?&](?:token|api[_-]?key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
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
    this.#token = options.token.trim();
    if (!this.#token) throw new CliError('Agent OS API token is required');
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
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${this.#token}`,
    });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (idempotencyKey !== undefined)
      headers.set('idempotency-key', idempotencyKey);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
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
      const code =
        typeof envelope?.error?.code === 'string'
          ? envelope.error.code
          : 'http_error';
      const message =
        typeof envelope?.error?.message === 'string'
          ? envelope.error.message
          : `request failed with HTTP ${response.status}`;
      throw new ApiError(
        redact(`${code}: ${message}`, this.#token),
        response.status,
        code,
      );
    }
    return parsed;
  }
}
