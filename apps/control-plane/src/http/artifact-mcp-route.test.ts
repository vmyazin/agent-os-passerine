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

  it('does not expose GET or DELETE transports', async () => {
    for (const response of [GET(), DELETE()]) {
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });
});
