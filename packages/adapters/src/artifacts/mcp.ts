import { createHash, randomUUID } from 'node:crypto';

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
export const MAX_AGENT_ARTIFACT_BYTES = 1024 * 1024;
export const DEFAULT_ARTIFACT_MCP_REQUEST_BYTES = 1_500_000;
export const DEFAULT_ARTIFACT_MCP_RESPONSE_BYTES = 1_500_000;

export interface ArtifactMcpHandlerOptions {
  readonly store: ArtifactStore;
  readonly capabilityVerifier: ArtifactCapabilityVerifier;
  readonly audience: string;
  readonly purpose?: string;
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

interface Session {
  readonly tokenHash: string;
  readonly expiresAt: number;
  initialized: boolean;
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

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
}

function validId(value: unknown): value is string | number {
  const hasControl = (text: string) =>
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  return (
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 128 &&
      !hasControl(value)) ||
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
  const type = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(type))
    throw new McpTransportError(
      415,
      'unsupported_media_type',
      'content type must be application/json',
    );
  const accepts = (request.headers.get('accept') ?? '')
    .toLowerCase()
    .split(',')
    .map((entry) => entry.split(';', 1)[0]?.trim());
  if (
    !accepts.includes('application/json') ||
    !accepts.includes('text/event-stream')
  )
    throw new McpTransportError(
      406,
      'not_acceptable',
      'both application/json and text/event-stream must be accepted',
    );
}

function enforceOrigin(request: Request, allowed: ReadonlySet<string>): void {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== '' && !allowed.has(origin))
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

function json(
  value: unknown,
  status: number,
  maxBytes: number,
  headers: Record<string, string> = {},
): Response {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes)
    return new Response(
      JSON.stringify({
        error: {
          code: 'response_too_large',
          message: 'response exceeds configured limit',
        },
      }),
      {
        status: 500,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  return new Response(encoded, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
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
    purpose: options.purpose ?? 'agent-artifact-access',
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

function base64Bytes(value: string, maxBytes: number): Uint8Array {
  if (value.length > 4 * Math.ceil(maxBytes / 3))
    throw new JsonRpcCallError(-32602, 'artifact exceeds MCP byte limit');
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > maxBytes || bytes.toString('base64') !== value)
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
        contentBase64: { type: 'string', maxLength: 1_398_104 },
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
        limit: { type: 'integer', minimum: 1, maximum: 100 },
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
  exactKeys(params, ['name', 'arguments', '_meta']);
  if (params.arguments !== undefined && !record(params.arguments))
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
  return { name: params.name, arguments: params.arguments ?? {} };
}

function toolResult(
  value: Record<string, unknown>,
  summary: string,
): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: value,
    isError: false,
  };
}

async function callTool(
  options: ArtifactMcpHandlerOptions,
  token: string,
  rpc: JsonRpcRequest,
  maxResponseBytes: number,
): Promise<Record<string, unknown>> {
  const call = toolArguments(rpc);
  if (!['artifact.get', 'artifact.put', 'artifact.list'].includes(call.name))
    throw new JsonRpcCallError(-32601, 'tool not found');
  if (call.name === 'artifact.get') {
    exactKeys(call.arguments, ['key']);
    const key = stringArgument(call.arguments, 'key')!;
    const parts = parseArtifactKey(key);
    const claims = capability(options, token, {
      method: 'artifact.get',
      projectId: parts.projectId,
      runId: parts.runId,
      stepId: parts.stepId,
      artifactId: parts.artifactId,
    });
    const responseContentLimit = Math.max(
      1,
      Math.floor((maxResponseBytes - 2_048) * 0.75),
    );
    const value = await options.store.get({
      scope: claims,
      key,
      maxBytes: Math.min(
        claims.maxBytes,
        MAX_AGENT_ARTIFACT_BYTES,
        responseContentLimit,
      ),
    });
    if (value === undefined)
      return toolResult({ found: false }, 'Artifact not found.');
    if (4 * Math.ceil(value.bytes.byteLength / 3) + 2_048 > maxResponseBytes)
      throw new JsonRpcCallError(-32602, 'artifact exceeds MCP response limit');
    return toolResult(
      {
        found: true,
        metadata: { ...value, bytes: undefined },
        contentBase64: Buffer.from(value.bytes).toString('base64'),
      },
      `Artifact retrieved (${value.sizeBytes} bytes).`,
    );
  }
  if (call.name === 'artifact.put') {
    exactKeys(call.arguments, [
      'artifactId',
      'version',
      'mediaType',
      'contentBase64',
      'digest',
      'retentionClass',
    ]);
    const artifactId = stringArgument(call.arguments, 'artifactId')!;
    const unverified = capability(options, token, {
      method: 'artifact.put',
      artifactId,
    });
    const bytes = base64Bytes(
      stringArgument(call.arguments, 'contentBase64')!,
      Math.min(unverified.maxBytes, MAX_AGENT_ARTIFACT_BYTES),
    );
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
    const metadata = await options.store.put({
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
    });
    return toolResult(
      { metadata },
      `Artifact stored (${metadata.sizeBytes} bytes).`,
    );
  }
  exactKeys(call.arguments, ['artifactPrefix', 'cursor', 'limit']);
  const requestedPrefix = stringArgument(
    call.arguments,
    'artifactPrefix',
    false,
  );
  const claims = capability(options, token, { method: 'artifact.list' });
  const effectivePrefix = requestedPrefix ?? claims.prefix;
  capability(options, token, {
    method: 'artifact.list',
    ...(effectivePrefix === undefined ? {} : { artifactId: effectivePrefix }),
  });
  const requestedLimit = integerArgument(call.arguments, 'limit', false);
  if (
    requestedLimit !== undefined &&
    (requestedLimit < 1 || requestedLimit > 100)
  )
    throw new JsonRpcCallError(-32602, 'invalid tool arguments');
  const page = await options.store.list({
    scope: claims,
    ...(effectivePrefix === undefined
      ? {}
      : { artifactPrefix: effectivePrefix }),
    ...(stringArgument(call.arguments, 'cursor', false) === undefined
      ? {}
      : { cursor: stringArgument(call.arguments, 'cursor', false)! }),
    ...(requestedLimit === undefined
      ? { limit: 100 }
      : { limit: requestedLimit }),
  });
  return toolResult({ page }, `Listed ${page.items.length} artifacts.`);
}

function validateInitialize(params: Record<string, unknown> | undefined): void {
  if (
    params === undefined ||
    typeof params.protocolVersion !== 'string' ||
    !record(params.capabilities) ||
    !record(params.clientInfo) ||
    typeof params.clientInfo.name !== 'string' ||
    params.clientInfo.name.length < 1 ||
    typeof params.clientInfo.version !== 'string' ||
    params.clientInfo.version.length < 1
  )
    throw new JsonRpcCallError(-32602, 'invalid initialize request');
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
  const sessions = new Map<string, Session>();
  const now = options.now ?? (() => new Date());
  const tokenHash = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  const sessionFor = (request: Request, token: string): Session => {
    const id = request.headers.get('mcp-session-id');
    const version = request.headers.get('mcp-protocol-version');
    const session = id === null ? undefined : sessions.get(id);
    if (
      version !== ARTIFACT_MCP_PROTOCOL_VERSION ||
      session === undefined ||
      session.tokenHash !== tokenHash(token) ||
      session.expiresAt <= now().getTime()
    )
      throw new McpTransportError(
        400,
        'invalid_session',
        'valid MCP session and protocol headers are required',
      );
    return session;
  };
  return async (request: Request): Promise<Response> => {
    try {
      enforceOrigin(request, allowedOrigins);
      const token = bearer(request);
      let claims: ArtifactCapabilityClaims;
      try {
        claims = capability(options, token);
      } catch {
        throw new McpTransportError(
          401,
          'invalid_capability',
          'artifact capability is invalid',
        );
      }
      if (request.method === 'DELETE') {
        const target = sessionFor(request, token);
        for (const [id, session] of sessions)
          if (session === target) sessions.delete(id);
        return new Response(null, {
          status: 204,
          headers: { 'cache-control': 'no-store' },
        });
      }
      if (request.method !== 'POST')
        throw new McpTransportError(
          405,
          'method_not_allowed',
          'only POST and DELETE are supported',
        );
      contentType(request);
      const value = await readBody(request, maxRequestBytes);
      if (Array.isArray(value))
        throw new McpTransportError(
          400,
          'batch_not_supported',
          'JSON-RPC batches are not supported',
        );
      const rpc = parseRpc(value);
      if (rpc.method === 'initialize') {
        if (rpc.id === undefined)
          throw new McpTransportError(
            400,
            'invalid_notification',
            'initialize requires an id',
          );
        try {
          validateInitialize(rpc.params);
        } catch (error) {
          const normalized = error as JsonRpcCallError;
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
        const id = randomUUID();
        sessions.set(id, {
          tokenHash: tokenHash(token),
          expiresAt: Date.parse(claims.expiresAt),
          initialized: false,
        });
        return json(
          {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'agentos-artifacts', version: '1.0.0' },
            },
          },
          200,
          maxResponseBytes,
          { 'mcp-session-id': id },
        );
      }
      const session = sessionFor(request, token);
      if (rpc.id === undefined) {
        if (rpc.method !== 'notifications/initialized')
          throw new McpTransportError(
            400,
            'invalid_notification',
            'notification is not supported',
          );
        session.initialized = true;
        return new Response(null, {
          status: 202,
          headers: { 'cache-control': 'no-store' },
        });
      }
      if (!session.initialized)
        throw new McpTransportError(
          400,
          'session_not_initialized',
          'MCP session is not initialized',
        );
      try {
        let result: unknown;
        if (rpc.method === 'tools/list') {
          if (rpc.params !== undefined)
            exactKeys(rpc.params, ['cursor', '_meta']);
          capability(options, token, { method: 'artifact.list' });
          result = { tools: TOOLS };
        } else if (rpc.method === 'tools/call')
          result = await callTool(options, token, rpc, maxResponseBytes);
        else throw new JsonRpcCallError(-32601, 'method not found');
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
      const normalized =
        error instanceof McpTransportError
          ? error
          : new McpTransportError(
              500,
              'internal_error',
              'artifact MCP request failed',
            );
      return json(
        { error: { code: normalized.code, message: normalized.message } },
        normalized.status,
        maxResponseBytes,
      );
    }
  };
}
