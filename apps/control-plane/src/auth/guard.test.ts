import { describe, expect, it } from 'vitest';

import { authenticateApiRequest, enforceBrowserMutationOrigin } from './guard';

const config = {
  clientId: 'client',
  clientSecret: 'secret',
  allowedLogin: 'operator',
  publicUrl: 'https://control.example',
  sessionSecret: '0123456789abcdef0123456789abcdef',
  cliToken: 'cli-secret',
};

describe('request authentication guard', () => {
  it('accepts a separate CLI bearer token', () => {
    const request = new Request('https://control.example/api/runs', {
      headers: { authorization: 'Bearer cli-secret' },
    });

    expect(authenticateApiRequest(request, config, 'GET')).toEqual({
      kind: 'cli',
    });
  });

  it('rejects cross-origin browser mutations', () => {
    const request = new Request('https://control.example/api/runs/1/cancel', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    });

    expect(() =>
      enforceBrowserMutationOrigin(request, config.publicUrl),
    ).toThrow('cross-origin mutation rejected');
  });

  it('never treats session or CLI auth as webhook authentication', () => {
    const request = new Request('https://control.example/api/webhooks/github', {
      headers: { authorization: 'Bearer cli-secret' },
    });

    expect(() => authenticateApiRequest(request, config, 'WEBHOOK')).toThrow(
      'webhook signature required',
    );
  });
});
