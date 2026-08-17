import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

import {
  createArtifactCapabilityIssuer,
  createArtifactCapabilityVerifier,
} from '@agentos/core';

import { createInMemoryArtifactStorage } from './in-memory.js';
import {
  ARTIFACT_MCP_PROTOCOL_VERSION,
  createArtifactMcpHandler,
  type ArtifactMcpHandler,
} from './mcp.js';

const now = new Date('2026-08-17T00:00:00.000Z');
const key = { keyId: 'primary', secret: 'p'.repeat(32) };
const issuer = createArtifactCapabilityIssuer(key);
const token = issuer.issue(
  {
    purpose: 'agent-artifact-access',
    audience: 'artifact-mcp',
    methods: ['artifact.get', 'artifact.put', 'artifact.list'],
    projectId: 'project-1',
    runId: 'run-1',
    stepId: 'step-1',
    prefix: 'spec',
    maxBytes: 1024,
    notBefore: now.toISOString(),
    expiresAt: '2026-08-17T00:10:00.000Z',
    nonce: 'nonce-1234567890',
  },
  now,
);

function fixture(
  options: { maxRequestBytes?: number; maxResponseBytes?: number } = {},
) {
  const storage = createInMemoryArtifactStorage({ now: () => now });
  return {
    storage,
    handler: createArtifactMcpHandler({
      store: storage.store,
      capabilityVerifier: createArtifactCapabilityVerifier({ keys: [key] }),
      audience: 'artifact-mcp',
      allowedOrigins: ['https://control.agentos.test'],
      now: () => now,
      ...options,
    }),
  };
}

function request(
  body: unknown,
  options: {
    token?: string;
    origin?: string | null;
    contentType?: string;
    accept?: string;
    sessionId?: string;
    protocolVersion?: string | null;
    method?: string;
  } = {},
): Request {
  const headers = new Headers({
    authorization: `Bearer ${options.token ?? token}`,
    'content-type': options.contentType ?? 'application/json',
    accept: options.accept ?? 'application/json, text/event-stream',
  });
  if (options.origin !== null)
    headers.set('origin', options.origin ?? 'https://control.agentos.test');
  if (options.sessionId !== undefined)
    headers.set('mcp-session-id', options.sessionId);
  if (options.protocolVersion !== null && options.protocolVersion !== undefined)
    headers.set('mcp-protocol-version', options.protocolVersion);
  return new Request('https://control.agentos.test/api/mcp/artifacts', {
    method: options.method ?? 'POST',
    headers,
    ...(options.method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
  });
}

async function initialized(
  handler: ArtifactMcpHandler,
  origin: string | null = 'https://control.agentos.test',
) {
  const response = await handler(
    request(
      {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      },
      { origin },
    ),
  );
  const sessionId = response.headers.get('mcp-session-id')!;
  expect(sessionId).toBeTruthy();
  expect((await response.json()) as object).toMatchObject({
    result: { protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION },
  });
  const notification = await handler(
    request(
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
      { origin, sessionId, protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION },
    ),
  );
  expect(notification.status).toBe(202);
  return (body: unknown, overrides: { protocolVersion?: string | null } = {}) =>
    handler(
      request(body, {
        origin,
        sessionId,
        protocolVersion:
          overrides.protocolVersion === undefined
            ? ARTIFACT_MCP_PROTOCOL_VERSION
            : overrides.protocolVersion,
      }),
    );
}

describe('Artifact MCP handler', () => {
  it('conforms through the exact-pinned official MCP client', async () => {
    const { handler } = fixture();
    const transport = new StreamableHTTPClientTransport(
      new URL('https://control.agentos.test/api/mcp/artifacts'),
      {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (_url, init) =>
          handler(
            new Request('https://control.agentos.test/api/mcp/artifacts', init),
          ),
      },
    );
    const client = new Client({ name: 'official-sdk-test', version: '1.0.0' });
    // SDK 1.30.0's declaration is internally incompatible with
    // exactOptionalPropertyTypes; keep that type quirk at this test boundary.
    await client.connect(
      transport as unknown as Parameters<Client['connect']>[0],
    );
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'artifact.get',
      'artifact.put',
      'artifact.list',
    ]);
    const stored = await client.callTool({
      name: 'artifact.put',
      arguments: {
        artifactId: 'spec-official',
        version: 1,
        mediaType: 'text/plain',
        contentBase64: Buffer.from('sdk').toString('base64'),
      },
    });
    expect(stored).toMatchObject({
      isError: false,
      structuredContent: { metadata: { artifactId: 'spec-official' } },
    });
    await client.close();
  });

  it('requires complete initialize fields and lifecycle protocol headers', async () => {
    const { handler } = fixture();
    for (const params of [
      {},
      { protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION },
    ]) {
      const response = await handler(
        request({ jsonrpc: '2.0', id: 1, method: 'initialize', params }),
      );
      expect((await response.json()) as object).toMatchObject({
        error: { code: -32602 },
      });
    }
    const call = await initialized(handler);
    for (const protocolVersion of [null, '2024-11-05']) {
      const response = await call(
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { protocolVersion },
      );
      expect(response.status).toBe(400);
    }
  });

  it('puts, gets, and lists without allowing request scope overrides', async () => {
    const { handler } = fixture();
    const call = await initialized(handler);
    const bad = await call({
      jsonrpc: '2.0',
      id: 'bad',
      method: 'tools/call',
      params: {
        name: 'artifact.put',
        arguments: {
          projectId: 'project-2',
          artifactId: 'spec-main',
          version: 1,
          mediaType: 'text/plain',
          contentBase64: Buffer.from('hello').toString('base64'),
        },
      },
    });
    expect((await bad.json()) as object).toMatchObject({
      error: { code: -32602 },
    });

    const put = await call({
      jsonrpc: '2.0',
      id: 'put',
      method: 'tools/call',
      params: {
        name: 'artifact.put',
        arguments: {
          artifactId: 'spec-main',
          version: 1,
          mediaType: 'text/plain',
          contentBase64: Buffer.from('hello').toString('base64'),
        },
      },
    });
    const putBody = (await put.json()) as {
      result: {
        content: Array<{ text: string }>;
        structuredContent: { metadata: { key: string } };
      };
    };
    expect(putBody.result).toMatchObject({
      isError: false,
      structuredContent: { metadata: { projectId: 'project-1' } },
    });
    expect(putBody.result.content[0]!.text).not.toContain('contentBase64');
    const artifactKey = putBody.result.structuredContent.metadata.key;

    const get = await call({
      jsonrpc: '2.0',
      id: 'get',
      method: 'tools/call',
      params: {
        name: 'artifact.get',
        arguments: { key: artifactKey },
      },
    });
    const getBody = (await get.json()) as {
      result: {
        content: Array<{ text: string }>;
        structuredContent: { contentBase64: string };
      };
    };
    expect(
      Buffer.from(
        getBody.result.structuredContent.contentBase64,
        'base64',
      ).toString(),
    ).toBe('hello');
    expect(getBody.result.content[0]!.text).not.toContain('aGVsbG8=');
  });

  it('allows authenticated remote clients without Origin but rejects a present unapproved Origin', async () => {
    const { handler } = fixture();
    await initialized(handler, null);
    const denied = await handler(
      request(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'x', version: '1' },
          },
        },
        { origin: 'https://evil.example' },
      ),
    );
    expect(denied.status).toBe(403);
  });

  it('rejects wrong schemas, delete tools, batches, and oversized transport bodies', async () => {
    const { handler } = fixture({ maxRequestBytes: 512 });
    const call = await initialized(handler);
    for (const args of [{ key: 'x', unexpected: true }, []]) {
      const response = await call({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'artifact.get', arguments: args },
      });
      expect((await response.json()) as object).toMatchObject({
        error: { code: -32602 },
      });
    }
    const deleted = await call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'artifact.delete', arguments: {} },
    });
    expect((await deleted.json()) as object).toMatchObject({
      error: { code: -32601 },
    });
    expect(
      (
        await handler(
          request([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          request({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'artifact.put',
              arguments: { contentBase64: 'a'.repeat(800) },
            },
          }),
        )
      ).status,
    ).toBe(413);
  });

  it('terminates sessions through DELETE without exposing an artifact delete tool', async () => {
    const { handler } = fixture();
    const init = await handler(
      request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'x', version: '1' },
        },
      }),
    );
    const sessionId = init.headers.get('mcp-session-id')!;
    const response = await handler(
      request(undefined, {
        method: 'DELETE',
        sessionId,
        protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION,
      }),
    );
    expect(response.status).toBe(204);
  });

  it('accepts the capability byte boundary and rejects one byte over before storage', async () => {
    const { handler, storage } = fixture();
    const call = await initialized(handler);
    const invoke = (size: number, version: number) =>
      call({
        jsonrpc: '2.0',
        id: size,
        method: 'tools/call',
        params: {
          name: 'artifact.put',
          arguments: {
            artifactId: 'spec-boundary',
            version,
            mediaType: 'application/octet-stream',
            contentBase64: Buffer.alloc(size).toString('base64'),
          },
        },
      });
    expect((await (await invoke(1024, 1)).json()) as object).toMatchObject({
      result: { isError: false },
    });
    expect((await (await invoke(1025, 2)).json()) as object).toMatchObject({
      error: { code: -32602 },
    });
    expect(
      (
        await storage.store.list({
          scope: { projectId: 'project-1', runId: 'run-1', stepId: 'step-1' },
        })
      ).items,
    ).toHaveLength(1);
  });

  it('returns a bounded sanitized response when the configured response cap is too small', async () => {
    const { handler } = fixture({ maxResponseBytes: 128 });
    const init = await handler(
      request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    );
    expect(init.status).toBe(500);
    const text = await init.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128);
    expect(text).not.toContain('stack');
    expect(text).not.toContain(token);
  });
});
