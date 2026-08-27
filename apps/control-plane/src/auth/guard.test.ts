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

  it('accepts a same-origin localhost mutation on a preview port', () => {
    const request = new Request('http://localhost:3119/api/approvals/1/approve', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3119',
        'sec-fetch-site': 'same-origin',
      },
    });

    expect(() =>
      enforceBrowserMutationOrigin(
        request,
        'http://localhost:3010',
        true,
      ),
    ).not.toThrow();
  });

  it('keeps preview-port mutations closed outside local development', () => {
    const request = new Request('http://localhost:3119/api/approvals/1/approve', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3119',
        'sec-fetch-site': 'same-origin',
      },
    });

    expect(() =>
      enforceBrowserMutationOrigin(request, 'http://localhost:3010'),
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
