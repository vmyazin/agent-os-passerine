import { describe, expect, it } from 'vitest';

import {
  createArtifactCapabilityIssuer,
  createArtifactCapabilityVerifier,
} from '@agentos/core';

import { createInMemoryArtifactStorage } from './in-memory.js';
import {
  ARTIFACT_MCP_PROTOCOL_VERSION,
  createArtifactMcpHandler,
} from './mcp.js';

const now = new Date('2026-08-17T00:00:00.000Z');
const key = { keyId: 'primary', secret: 'p'.repeat(32) };
const issuer = createArtifactCapabilityIssuer(key);
const token = issuer.issue(
  {
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
    origin?: string;
    contentType?: string;
    accept?: string;
  } = {},
): Request {
  return new Request('https://control.agentos.test/api/mcp/artifacts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token ?? token}`,
      origin: options.origin ?? 'https://control.agentos.test',
      'content-type': options.contentType ?? 'application/json',
      accept: options.accept ?? 'application/json',
    },
    body: JSON.stringify(body),
  });
}

interface TestJsonBody extends Record<string, unknown> {
  readonly result?: {
    readonly tools?: Array<{ readonly name: string }>;
    readonly content?: Array<{ readonly text: string }>;
  };
  readonly error?: { readonly code: number };
}

async function json(response: Response): Promise<TestJsonBody> {
  return (await response.json()) as TestJsonBody;
}

describe('Artifact MCP handler', () => {
  it('requires a secure configured origin except for localhost development', () => {
    const storage = createInMemoryArtifactStorage();
    const base = {
      store: storage.store,
      capabilityVerifier: createArtifactCapabilityVerifier({ keys: [key] }),
      audience: 'artifact-mcp',
    };
    expect(() =>
      createArtifactMcpHandler({
        ...base,
        allowedOrigins: ['http://control.example.com'],
      }),
    ).toThrow(/HTTPS/i);
    expect(() =>
      createArtifactMcpHandler({
        ...base,
        allowedOrigins: ['http://localhost:3000'],
      }),
    ).not.toThrow();
  });

  it('implements pinned initialize lifecycle and lists only three tools', async () => {
    const { handler } = fixture();
    const initialized = await handler(
      request({
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: { protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION },
      }),
    );
    expect(await json(initialized)).toMatchObject({
      jsonrpc: '2.0',
      id: 'init-1',
      result: { protocolVersion: ARTIFACT_MCP_PROTOCOL_VERSION },
    });
    const notification = await handler(
      request({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(notification.status).toBe(202);
    const listed = await handler(
      request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    );
    const names = (await json(listed)).result!.tools!.map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toEqual(['artifact.get', 'artifact.put', 'artifact.list']);
    expect(names).not.toContain('artifact.delete');
  });

  it('puts, gets, and lists using capability scope rather than request scope', async () => {
    const { handler } = fixture();
    const put = await handler(
      request({
        jsonrpc: '2.0',
        id: 'put',
        method: 'tools/call',
        params: {
          name: 'artifact.put',
          arguments: {
            projectId: 'project-2',
            runId: 'run-2',
            stepId: 'step-2',
            artifactId: 'spec-main',
            version: 1,
            mediaType: 'text/plain',
            contentBase64: Buffer.from('hello').toString('base64'),
          },
        },
      }),
    );
    const putBody = await json(put);
    expect(putBody.error).toBeUndefined();
    const stored = JSON.parse(putBody.result!.content![0]!.text) as {
      key: string;
    };
    expect(stored.key).toContain('/project-1/run-1/step-1/');
    expect(stored.key).not.toContain('project-2');

    const get = await handler(
      request({
        jsonrpc: '2.0',
        id: 'get',
        method: 'tools/call',
        params: { name: 'artifact.get', arguments: { key: stored.key } },
      }),
    );
    const got = JSON.parse((await json(get)).result!.content![0]!.text) as {
      contentBase64: string;
    };
    expect(Buffer.from(got.contentBase64, 'base64').toString()).toBe('hello');

    const list = await handler(
      request({
        jsonrpc: '2.0',
        id: 'list',
        method: 'tools/call',
        params: { name: 'artifact.list', arguments: {} },
      }),
    );
    expect(
      (
        JSON.parse((await json(list)).result!.content![0]!.text) as {
          items: unknown[];
        }
      ).items,
    ).toHaveLength(1);
  });

  it('denies cross-prefix and cross-run access even when a key is known', async () => {
    const { handler, storage } = fixture();
    const other = await storage.store.put({
      scope: { projectId: 'project-1', runId: 'run-2', stepId: 'step-1' },
      artifactId: 'spec-main',
      version: 1,
      bytes: new TextEncoder().encode('secret'),
      mediaType: 'text/plain',
    });
    for (const arguments_ of [
      { key: other.key },
      { artifactPrefix: 'other' },
    ]) {
      const name = 'key' in arguments_ ? 'artifact.get' : 'artifact.list';
      const response = await handler(
        request({
          jsonrpc: '2.0',
          id: name,
          method: 'tools/call',
          params: { name, arguments: arguments_ },
        }),
      );
      expect((await json(response)).error).toMatchObject({ code: -32001 });
    }
  });

  it('rejects unknown/delete tools, batches, arbitrary notifications, and invalid IDs', async () => {
    const { handler } = fixture();
    for (const body of [
      [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'artifact.get' },
      },
      { jsonrpc: '2.0', id: null, method: 'tools/list' },
    ]) {
      const response = await handler(request(body));
      expect(response.status).toBe(400);
    }
    for (const name of ['artifact.delete', 'unknown']) {
      const response = await handler(
        request({
          jsonrpc: '2.0',
          id: name,
          method: 'tools/call',
          params: { name, arguments: {} },
        }),
      );
      expect((await json(response)).error).toMatchObject({ code: -32601 });
    }
  });

  it.each([
    ['missing origin', { origin: '' }, 403],
    ['wrong origin', { origin: 'https://evil.example' }, 403],
    ['wrong content type', { contentType: 'text/plain' }, 415],
    ['wrong accept', { accept: 'text/event-stream' }, 406],
    ['bad token', { token: 'secret-token-value' }, 401],
  ])(
    'rejects %s without reflecting authorization',
    async (_label, headers, status) => {
      const { handler } = fixture();
      const response = await handler(
        request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers),
      );
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(
        'token' in headers ? headers.token : token,
      );
    },
  );

  it('enforces request and response byte limits', async () => {
    const smallRequest = fixture({ maxRequestBytes: 128 }).handler;
    expect(
      (
        await smallRequest(
          request({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'artifact.put',
              arguments: { contentBase64: 'a'.repeat(256) },
            },
          }),
        )
      ).status,
    ).toBe(413);

    const { handler } = fixture({ maxResponseBytes: 128 });
    const response = await handler(
      request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('stack');
  });
});
