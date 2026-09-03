import { createHash } from 'node:crypto';

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
import type { ArtifactCapabilityQuotaStore } from './quota.js';

export const ARTIFACT_MCP_PROTOCOL_VERSION = '2025-06-18';
export const MAX_AGENT_ARTIFACT_BYTES = 1024 * 1024;
export const DEFAULT_ARTIFACT_MCP_REQUEST_BYTES = 1_500_000;
export const DEFAULT_ARTIFACT_MCP_RESPONSE_BYTES = 1_500_000;

export interface ArtifactMcpHandlerOptions {
  readonly store: ArtifactStore;
  readonly quotaStore: ArtifactCapabilityQuotaStore;
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

// Managed Agents rejects MCP tool names containing '.', so the advertised
// names use underscores. tools/call accepts both spellings; capability
// claims keep the historical dotted method names.
const TOOLS = Object.freeze([
  {
    name: 'artifact_get',
    description: 'Read one immutable artifact within the granted scope.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_put',
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
    name: 'artifact_list',
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

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!record(value)) return 'null';
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

function operationId(rpc: JsonRpcRequest): string {
  return createHash('sha256').update(canonical(rpc), 'utf8').digest('hex');
}

async function consumeQuota(
  options: ArtifactMcpHandlerOptions,
  claims: ArtifactCapabilityClaims,
  rpc: JsonRpcRequest,
  bytes: number,
): Promise<void> {
  await options.quotaStore.consume(claims, {
    operationId: operationId(rpc),
    bytes,
    now: (options.now ?? (() => new Date()))(),
  });
}

async function callTool(
  options: ArtifactMcpHandlerOptions,
  token: string,
  rpc: JsonRpcRequest,
  maxResponseBytes: number,
): Promise<Record<string, unknown>> {
  const rawCall = toolArguments(rpc);
  // Accept both the advertised underscore names and the historical dotted
  // names; internal capability methods stay dotted.
  const call = {
    ...rawCall,
    name: rawCall.name.replace(/^artifact_/, 'artifact.'),
  };
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
    const readLimit = Math.min(
      claims.maxBytes,
      MAX_AGENT_ARTIFACT_BYTES,
      responseContentLimit,
    );
    await consumeQuota(options, claims, rpc, readLimit);
    const value = await options.store.get({
      scope: claims,
      key,
      maxBytes: readLimit,
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
    const mediaType = stringArgument(call.arguments, 'mediaType')!;
    // A body that is well-formed base64 of valid UTF-8 but not actually JSON
    // clears every other check here, is hashed and stored immutably, and only
    // fails when a later step reads it back -- permanently, after the whole
    // session has been paid for. Rejecting it now returns a tool error while
    // the agent still holds the session and can re-send a corrected body.
    if (/^application\/json\s*(?:;|$)/i.test(mediaType.trim())) {
      try {
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (error) {
        // The reason travels back to the agent, which is the only party that
        // can fix it, and it describes the agent's own content.
        throw new JsonRpcCallError(
          -32602,
          `contentBase64 must decode to valid JSON for mediaType application/json: ${
            error instanceof Error
              ? error.message.slice(0, 200)
              : 'parse failed'
          }`,
        );
      }
    }
    const claims = capability(options, token, {
      method: 'artifact.put',
      artifactId,
      bytes: bytes.byteLength,
    });
    await consumeQuota(options, claims, rpc, bytes.byteLength);
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
      mediaType,
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
  await consumeQuota(options, claims, rpc, 0);
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
  exactKeys(params, ['protocolVersion', 'capabilities', 'clientInfo', '_meta']);
  exactKeys(params.clientInfo, ['name', 'version', 'title']);
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
      if (request.method !== 'POST')
        throw new McpTransportError(
          405,
          'method_not_allowed',
          'only POST is supported',
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
        );
      }
      if (
        request.headers.get('mcp-protocol-version') !==
        ARTIFACT_MCP_PROTOCOL_VERSION
      )
        throw new McpTransportError(
          400,
          'invalid_protocol_version',
          'a supported MCP protocol header is required',
        );
      if (rpc.id === undefined) {
        return new Response(null, {
          status: 202,
          headers: { 'cache-control': 'no-store' },
        });
      }
      try {
        let result: unknown;
        if (rpc.method === 'ping') {
          const claims = capability(options, token);
          await consumeQuota(options, claims, rpc, 0);
          result = {};
        } else if (rpc.method === 'tools/list') {
          if (rpc.params !== undefined)
            exactKeys(rpc.params, ['cursor', '_meta']);
          const claims = capability(options, token, {
            method: 'artifact.list',
          });
          await consumeQuota(options, claims, rpc, 0);
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
              : error instanceof ArtifactStoreAdapterError &&
                  error.code === 'artifact_quota_exhausted'
                ? new JsonRpcCallError(
                    -32002,
                    'artifact capability quota exhausted',
                  )
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
