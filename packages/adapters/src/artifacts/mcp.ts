import {
  ArtifactCapabilityError,
  ArtifactValidationError,
  parseArtifactKey,
  type ArtifactCapabilityClaims,
  type ArtifactCapabilityMethod,
  type ArtifactCapabilityVerifier,
  type ArtifactRetentionClass,
  type ArtifactStore,
} from '@agentos/core';

import { ArtifactStoreAdapterError } from './errors.js';

export const ARTIFACT_MCP_PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_ARTIFACT_MCP_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_ARTIFACT_MCP_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ArtifactMcpHandlerOptions {
  readonly store: ArtifactStore;
  readonly capabilityVerifier: ArtifactCapabilityVerifier;
  readonly audience: string;
  readonly allowedOrigins: readonly string[];
  readonly now?: () => Date;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export type ArtifactMcpHandler = (request: Request) => Promise<Response>;

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

class McpTransportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class JsonRpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string | number {
  const hasControlCharacter = (text: string) =>
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  return (
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 128 &&
      !hasControlCharacter(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
}

function parseRpc(value: unknown): JsonRpcRequest {
  if (
    !record(value) ||
    value.jsonrpc !== '2.0' ||
    typeof value.method !== 'string'
  )
    throw new McpTransportError(
      400,
      'invalid_request',
      'invalid JSON-RPC request',
    );
  if ('id' in value && !validId(value.id))
    throw new McpTransportError(
      400,
      'invalid_request',
      'invalid JSON-RPC request',
    );
  if (value.params !== undefined && !record(value.params))
    throw new McpTransportError(
      400,
      'invalid_request',
      'invalid JSON-RPC request',
    );
  return {
    jsonrpc: '2.0',
    ...(value.id === undefined ? {} : { id: value.id as string | number }),
    method: value.method,
    ...(value.params === undefined
      ? {}
      : { params: value.params as Record<string, unknown> }),
  };
}

function contentType(request: Request): void {
  const value = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(value))
    throw new McpTransportError(
      415,
      'unsupported_media_type',
      'content type must be application/json',
    );
  const accept = request.headers.get('accept')?.toLowerCase() ?? '';
  if (
    !accept
      .split(',')
      .map((entry) => entry.split(';', 1)[0]?.trim())
      .some((entry) => entry === 'application/json' || entry === '*/*')
  )
    throw new McpTransportError(
      406,
      'not_acceptable',
      'application/json response is required',
    );
}

function enforceOrigin(request: Request, allowed: ReadonlySet<string>): void {
  const origin = request.headers.get('origin');
  if (origin === null || origin === '' || !allowed.has(origin))
    throw new McpTransportError(
      403,
      'origin_denied',
      'request origin is not allowed',
    );
}

function bearer(request: Request): string {
  const value = request.headers.get('authorization');
  if (
    value === null ||
    value.length > 8_199 ||
    !value.startsWith('Bearer ') ||
    value.slice(7).length < 1 ||
    /\s/.test(value.slice(7))
  )
    throw new McpTransportError(
      401,
      'authentication_required',
      'artifact capability is required',
    );
  return value.slice(7);
}

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null) {
    const parsed = Number(length);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new McpTransportError(
        400,
        'invalid_content_length',
        'content length is invalid',
      );
    if (parsed > maxBytes) {
      await request.body?.cancel();
      throw new McpTransportError(
        413,
        'payload_too_large',
        'request body is too large',
      );
    }
  }
  const reader = request.body?.getReader();
  if (reader === undefined)
    throw new McpTransportError(
      400,
      'invalid_json',
      'request body is required',
    );
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new McpTransportError(
          413,
          'payload_too_large',
          'request body is too large',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new McpTransportError(
      400,
      'invalid_json',
      'request body must be valid UTF-8 JSON',
    );
  }
}

function json(value: unknown, status: number, maxBytes: number): Response {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    const fallback = JSON.stringify({
      error: {
        code: 'response_too_large',
        message: 'response exceeds configured limit',
      },
    });
    return new Response(fallback, {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(encoded, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function transportError(error: McpTransportError, maxBytes: number): Response {
  return json(
    { error: { code: error.code, message: error.message } },
    error.status,
    maxBytes,
  );
}

function capability(
  options: ArtifactMcpHandlerOptions,
  token: string,
  expected: {
    readonly method?: ArtifactCapabilityMethod;
    readonly projectId?: string;
    readonly runId?: string;
    readonly stepId?: string;
    readonly artifactId?: string;
    readonly bytes?: number;
  } = {},
): ArtifactCapabilityClaims {
  return options.capabilityVerifier.verify(token, {
    audience: options.audience,
    now: (options.now ?? (() => new Date()))(),
    ...expected,
  });
}

function stringArgument(
  value: Record<string, unknown>,
  key: string,
  required = true,
): string | undefined {
  const entry = value[key];
  if (entry === undefined && !required) return undefined;
  if (typeof entry !== 'string' || entry.length === 0)
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
  return entry;
}

function integerArgument(
  value: Record<string, unknown>,
  key: string,
  required = true,
): number | undefined {
  const entry = value[key];
  if (entry === undefined && !required) return undefined;
  if (!Number.isSafeInteger(entry))
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
  return entry as number;
}

function base64Bytes(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value)
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
  return bytes;
}

const TOOLS = Object.freeze([
  {
    name: 'artifact.get',
    description: 'Read one immutable artifact within the granted scope.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact.put',
    description:
      'Write one immutable content-addressed artifact within the granted scope.',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        mediaType: { type: 'string' },
        contentBase64: { type: 'string' },
        digest: { type: 'string' },
        retentionClass: {
          enum: ['source-bundle', 'cloud-session-upload', 'working'],
        },
      },
      required: ['artifactId', 'version', 'mediaType', 'contentBase64'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact.list',
    description: 'List immutable artifact metadata within the granted scope.',
    inputSchema: {
      type: 'object',
      properties: {
        artifactPrefix: { type: 'string' },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
]);

function toolArguments(rpc: JsonRpcRequest): {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
} {
  const params = rpc.params;
  if (params === undefined || typeof params.name !== 'string')
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
  if (params.arguments !== undefined && !record(params.arguments))
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
  return { name: params.name, arguments: params.arguments ?? {} };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function callTool(
  options: ArtifactMcpHandlerOptions,
  token: string,
  rpc: JsonRpcRequest,
): Promise<Record<string, unknown>> {
  const call = toolArguments(rpc);
  if (!['artifact.get', 'artifact.put', 'artifact.list'].includes(call.name))
    throw new JsonRpcCallError(-32601, 'tool not found');
  if (call.name === 'artifact.get') {
    const key = stringArgument(call.arguments, 'key')!;
    const parts = parseArtifactKey(key);
    const claims = capability(options, token, {
      method: 'artifact.get',
      projectId: parts.projectId,
      runId: parts.runId,
      stepId: parts.stepId,
      artifactId: parts.artifactId,
    });
    const value = await options.store.get({
      scope: claims,
      key,
      maxBytes: claims.maxBytes,
    });
    return toolResult(
      value === undefined
        ? null
        : {
            ...value,
            bytes: undefined,
            contentBase64: Buffer.from(value.bytes).toString('base64'),
          },
    );
  }
  if (call.name === 'artifact.put') {
    const artifactId = stringArgument(call.arguments, 'artifactId')!;
    const contentBase64 = stringArgument(call.arguments, 'contentBase64')!;
    const bytes = base64Bytes(contentBase64);
    const claims = capability(options, token, {
      method: 'artifact.put',
      artifactId,
      bytes: bytes.byteLength,
    });
    const retention = stringArgument(call.arguments, 'retentionClass', false);
    if (
      retention !== undefined &&
      !['source-bundle', 'cloud-session-upload', 'working'].includes(retention)
    )
      throw new JsonRpcCallError(-32602, 'invalid tool arguments');
    return toolResult(
      await options.store.put({
        scope: claims,
        artifactId,
        version: integerArgument(call.arguments, 'version')!,
        bytes,
        mediaType: stringArgument(call.arguments, 'mediaType')!,
        ...(stringArgument(call.arguments, 'digest', false) === undefined
          ? {}
          : { digest: stringArgument(call.arguments, 'digest', false)! }),
        ...(retention === undefined
          ? {}
          : { retentionClass: retention as ArtifactRetentionClass }),
      }),
    );
  }
  const requestedPrefix = stringArgument(
    call.arguments,
    'artifactPrefix',
    false,
  );
  const initialClaims = capability(options, token, { method: 'artifact.list' });
  const effectivePrefix = requestedPrefix ?? initialClaims.prefix;
  capability(options, token, {
    method: 'artifact.list',
    ...(effectivePrefix === undefined ? {} : { artifactId: effectivePrefix }),
  });
  return toolResult(
    await options.store.list({
      scope: initialClaims,
      ...(effectivePrefix === undefined
        ? {}
        : { artifactPrefix: effectivePrefix }),
      ...(stringArgument(call.arguments, 'cursor', false) === undefined
        ? {}
        : { cursor: stringArgument(call.arguments, 'cursor', false)! }),
      ...(integerArgument(call.arguments, 'limit', false) === undefined
        ? {}
        : { limit: integerArgument(call.arguments, 'limit', false)! }),
    }),
  );
}

async function dispatch(
  options: ArtifactMcpHandlerOptions,
  token: string,
  rpc: JsonRpcRequest,
): Promise<unknown> {
  if (rpc.method === 'initialize') {
    capability(options, token);
    if (
      rpc.params?.protocolVersion !== undefined &&
      rpc.params.protocolVersion !== ARTIFACT_MCP_PROTOCOL_VERSION
    )
      throw new JsonRpcCallError(-32602, 'unsupported protocol version');
    return {
      protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'agentos-artifacts', version: '1.0.0' },
    };
  }
  if (rpc.method === 'tools/list') {
    capability(options, token, { method: 'artifact.list' });
    return { tools: TOOLS };
  }
  if (rpc.method === 'tools/call') return callTool(options, token, rpc);
  throw new JsonRpcCallError(-32601, 'method not found');
}

export function createArtifactMcpHandler(
  options: ArtifactMcpHandlerOptions,
): ArtifactMcpHandler {
  if (options.allowedOrigins.length < 1)
    throw new Error('Artifact MCP requires at least one allowed origin');
  const allowedOrigins = new Set(
    options.allowedOrigins.map((value) => {
      const parsed = new URL(value);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(
        parsed.hostname,
      );
      if (
        parsed.username !== '' ||
        parsed.password !== '' ||
        (parsed.protocol !== 'https:' &&
          !(parsed.protocol === 'http:' && local)) ||
        parsed.origin !== value
      )
        throw new Error(
          'Artifact MCP origins must be exact HTTPS origins (HTTP is localhost-only)',
        );
      return parsed.origin;
    }),
  );
  const maxRequestBytes =
    options.maxRequestBytes ?? DEFAULT_ARTIFACT_MCP_REQUEST_BYTES;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_ARTIFACT_MCP_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 128)
    throw new Error('Artifact MCP request limit is invalid');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 128)
    throw new Error('Artifact MCP response limit is invalid');
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST')
        throw new McpTransportError(
          405,
          'method_not_allowed',
          'only POST is supported',
        );
      contentType(request);
      enforceOrigin(request, allowedOrigins);
      const token = bearer(request);
      try {
        capability(options, token);
      } catch {
        throw new McpTransportError(
          401,
          'invalid_capability',
          'artifact capability is invalid',
        );
      }
      const value = await readBody(request, maxRequestBytes);
      if (Array.isArray(value))
        throw new McpTransportError(
          400,
          'batch_not_supported',
          'JSON-RPC batches are not supported',
        );
      const rpc = parseRpc(value);
      if (rpc.id === undefined) {
        if (rpc.method !== 'notifications/initialized')
          throw new McpTransportError(
            400,
            'invalid_notification',
            'notification is not supported',
          );
        capability(options, token);
        return new Response(null, { status: 202 });
      }
      try {
        const result = await dispatch(options, token, rpc);
        return json(
          { jsonrpc: '2.0', id: rpc.id, result },
          200,
          maxResponseBytes,
        );
      } catch (error) {
        const normalized =
          error instanceof JsonRpcCallError
            ? error
            : error instanceof ArtifactCapabilityError ||
                (error instanceof ArtifactStoreAdapterError &&
                  error.code === 'artifact_scope_denied')
              ? new JsonRpcCallError(-32001, 'artifact capability denied')
              : error instanceof ArtifactValidationError ||
                  error instanceof ArtifactStoreAdapterError
                ? new JsonRpcCallError(-32602, 'artifact request is invalid')
                : new JsonRpcCallError(-32603, 'artifact operation failed');
        return json(
          {
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: normalized.code, message: normalized.message },
          },
          200,
          maxResponseBytes,
        );
      }
    } catch (error) {
      return transportError(
        error instanceof McpTransportError
          ? error
          : new McpTransportError(
              500,
              'internal_error',
              'artifact MCP request failed',
            ),
        maxResponseBytes,
      );
    }
  };
}
