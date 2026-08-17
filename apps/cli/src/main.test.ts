import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { STARTER_CONFIG } from './config-files.js';
import { HELP_TEXT, runCli } from './main.js';

function capture(
  options: {
    readonly fetch?: typeof fetch;
    readonly env?: NodeJS.ProcessEnv;
    readonly stdin?: () => Promise<string>;
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      env: options.env ?? {},
      fetch: options.fetch,
      readStdin: options.stdin ?? (async () => ''),
    },
    stdout,
    stderr,
  };
}

describe('runCli', () => {
  it('returns stable exit codes and actionable human/JSON errors', async () => {
    const usage = capture();
    await expect(runCli(['runs', 'show'], usage.io)).resolves.toBe(2);
    expect(usage.stderr.join('')).toContain('unknown command');

    const json = capture();
    await expect(runCli(['--json', 'runs', 'show'], json.io)).resolves.toBe(2);
    expect(JSON.parse(json.stderr.join(''))).toMatchObject({
      error: { code: 'usage_error' },
    });
  });

  it('prints help and version without network access', async () => {
    const help = capture();
    await expect(runCli(['--help'], help.io)).resolves.toBe(0);
    expect(help.stdout.join('')).toBe(HELP_TEXT);

    const version = capture();
    await expect(runCli(['--version'], version.io)).resolves.toBe(0);
    expect(version.stdout.join('')).toMatch(/^agentos \d+\.\d+\.\d+\n$/);
  });

  it('validates locally and produces semantic no-op plans against the server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentos-plan-'));
    const path = join(root, 'agent-os.yaml');
    await writeFile(path, STARTER_CONFIG);

    const validate = capture();
    await expect(
      runCli(['--json', 'config', 'validate', '--config', path], validate.io),
    ).resolves.toBe(0);
    expect(JSON.parse(validate.stdout.join(''))).toMatchObject({ valid: true });

    const fetch = vi.fn(async () =>
      Response.json({
        active: {
          canonicalConfig: JSON.stringify(
            (await import('@agentos/core')).loadAgentOsConfig(STARTER_CONFIG),
          ),
          digest: (await import('@agentos/core')).canonicalConfigHash(
            (await import('@agentos/core')).loadAgentOsConfig(STARTER_CONFIG),
          ),
          revision: 1,
          appliedAt: '2026-08-17T12:00:00.000Z',
        },
      }),
    );
    const plan = capture({
      fetch,
      env: {
        AGENTOS_URL: 'https://control.example',
        AGENTOS_API_TOKEN: 'token',
      },
    });
    await expect(
      runCli(['--json', 'config', 'plan', '--config', path], plan.io),
    ).resolves.toBe(0);
    expect(JSON.parse(plan.stdout.join(''))).toMatchObject({
      changed: false,
      changes: [],
    });
  });

  it('applies canonical configuration and resolves reply content from bounded stdin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentos-apply-'));
    const path = join(root, 'agent-os.yaml');
    await writeFile(path, STARTER_CONFIG);
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return Response.json({ ok: true });
      },
    );
    const shared = {
      fetch: fetch as typeof globalThis.fetch,
      env: {
        AGENTOS_URL: 'https://control.example',
        AGENTOS_API_TOKEN: 'token',
      },
    };

    const apply = capture(shared);
    await expect(
      runCli(
        ['config', 'apply', '--config', path, '--idempotency-key', 'apply-1'],
        apply.io,
      ),
    ).resolves.toBe(0);
    expect(requests[0]?.url).toBe(
      'https://control.example/api/configuration/apply',
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      canonicalConfig: expect.any(String),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const reply = capture({ ...shared, stdin: async () => 'approved\n' });
    await expect(
      runCli(
        ['inbox', 'reply', 'message_1', '--idempotency-key', 'reply-1'],
        reply.io,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      reply: 'approved',
    });
  });

  it('does not expose the API token when transport errors contain it', async () => {
    const failure = capture({
      env: {
        AGENTOS_URL: 'https://control.example',
        AGENTOS_API_TOKEN: 'super-secret-token',
      },
      fetch: vi.fn(async () => {
        throw new Error('connection rejected super-secret-token');
      }),
    });
    const code = await runCli(['runs', 'list'], failure.io);
    expect(code).toBe(3);
    expect(failure.stderr.join('')).toContain('[REDACTED]');
    expect(failure.stderr.join('')).not.toContain('super-secret-token');
  });
});
