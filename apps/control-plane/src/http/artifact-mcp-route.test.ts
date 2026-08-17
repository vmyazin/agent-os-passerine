import { afterEach, describe, expect, it, vi } from 'vitest';

import { DELETE, GET, POST } from '../../app/api/mcp/artifacts/route';
import { setArtifactMcpHandlerForTests } from '../application/artifact-mcp-runtime';

afterEach(() => setArtifactMcpHandlerForTests(undefined));

describe('Artifact MCP route', () => {
  it('delegates POST to the isolated handler without normal API authentication', async () => {
    const delegated = vi.fn(async () => new Response('mcp', { status: 202 }));
    setArtifactMcpHandlerForTests(delegated);
    const request = new Request(
      'https://control.agentos.test/api/mcp/artifacts',
      {
        method: 'POST',
      },
    );
    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(delegated).toHaveBeenCalledWith(request);
  });

  it('keeps GET disabled and delegates DELETE for MCP session teardown', async () => {
    expect(GET().status).toBe(405);
    expect(GET().headers.get('allow')).toBe('POST, DELETE');
    const delegated = vi.fn(async () => new Response(null, { status: 204 }));
    setArtifactMcpHandlerForTests(delegated);
    const request = new Request(
      'https://control.agentos.test/api/mcp/artifacts',
      { method: 'DELETE' },
    );
    expect((await DELETE(request)).status).toBe(204);
    expect(delegated).toHaveBeenCalledWith(request);
  });
});
