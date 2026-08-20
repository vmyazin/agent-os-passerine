import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
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
    readonly cwd?: string;
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
      cwd: options.cwd,
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
    for (const required of [
      'runs cancel ID --idempotency-key KEY',
      'inbox reply ID (--reply TEXT | --file PATH | stdin) --idempotency-key KEY',
      'inbox approve ID --scope-hash HASH --idempotency-key KEY',
      'inbox reject ID --scope-hash HASH --idempotency-key KEY',
    ]) {
      expect(help.stdout.join('')).toContain(required);
    }
  });

  it('validates locally and produces semantic no-op plans against the server', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentos-plan-')));
    const path = join(root, 'agent-os.yaml');
    await writeFile(join(root, '.git'), 'gitdir: test\n');
    await writeFile(path, STARTER_CONFIG);

    const validate = capture({ cwd: root });
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
      cwd: root,
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
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'agentos-apply-')),
    );
    const path = join(root, 'agent-os.yaml');
    await writeFile(join(root, '.git'), 'gitdir: test\n');
    await writeFile(path, STARTER_CONFIG);
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (init?.method === 'GET') {
          return Response.json({
            active: {
              projectId: 'project_1',
              digest: 'a'.repeat(64),
              revision: 7,
              appliedAt: '2026-08-17T12:00:00.000Z',
              canonicalConfig: '{}',
            },
          });
        }
        return Response.json({ ok: true });
      },
    );
    const shared = {
      fetch: fetch as typeof globalThis.fetch,
      cwd: root,
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
      'https://control.example/api/configuration?name=example',
    );
    expect(requests[1]?.url).toBe(
      'https://control.example/api/configuration/apply',
    );
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      canonicalConfig: expect.any(String),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedRevision: 7,
      expectedDigest: 'a'.repeat(64),
    });

    const reply = capture({ ...shared, stdin: async () => 'approved\n' });
    await expect(
      runCli(
        ['inbox', 'reply', 'message_1', '--idempotency-key', 'reply-1'],
        reply.io,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      reply: 'approved',
    });
  });

  it('starts a feature from the immutable provenance returned by config apply', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'agentos-apply-start-')),
    );
    const path = join(root, 'agent-os.yaml');
    await writeFile(join(root, '.git'), 'gitdir: test\n');
    await writeFile(path, STARTER_CONFIG);
    const provenance = {
      repositorySha: 'a'.repeat(40),
      configDigest: 'b'.repeat(64),
      modelDigest: 'c'.repeat(64),
      promptDigest: 'd'.repeat(64),
      environmentDigest: 'e'.repeat(64),
      policyDigest: 'f'.repeat(64),
    };
    const requests: Array<{
      url: string;
      init: RequestInit | undefined;
    }> = [];
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (init?.method === 'GET') return Response.json({ active: null });
        if (String(url).endsWith('/api/configuration/apply'))
          return Response.json({
            projectId: 'project_1',
            digest: provenance.configDigest,
            revision: 1,
            appliedAt: '2026-08-17T12:00:00.000Z',
            provenance,
          });
        return Response.json({ id: 'run_1', status: 'pending' });
      },
    );
    const shared = {
      fetch: fetch as typeof globalThis.fetch,
      cwd: root,
      env: {
        AGENTOS_URL: 'https://control.example',
        AGENTOS_API_TOKEN: 'token',
      },
    };
    const apply = capture(shared);
    expect(
      await runCli(
        [
          '--json',
          'config',
          'apply',
          '--config',
          path,
          '--idempotency-key',
          'apply-start',
        ],
        apply.io,
      ),
    ).toBe(0);
    const applied = JSON.parse(apply.stdout.join('')) as {
      projectId: string;
      provenance: typeof provenance;
    };

    const start = capture(shared);
    expect(
      await runCli(
        [
          'feature',
          'start',
          '--project-id',
          applied.projectId,
          '--title',
          'Projected feature',
          '--description',
          'Start from config apply output.',
          '--repository-sha',
          applied.provenance.repositorySha,
          '--config-digest',
          applied.provenance.configDigest,
          '--model-digest',
          applied.provenance.modelDigest,
          '--prompt-digest',
          applied.provenance.promptDigest,
          '--environment-digest',
          applied.provenance.environmentDigest,
          '--policy-digest',
          applied.provenance.policyDigest,
          '--idempotency-key',
          'feature-start',
        ],
        start.io,
      ),
    ).toBe(0);
    expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
      projectId: 'project_1',
      ...provenance,
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

  it('rejects an invalid environment API token without exposing it', async () => {
    const token = 'super-secret-token\nsmuggled-header';
    const fetch = vi.fn();
    const failure = capture({
      env: {
        AGENTOS_URL: 'https://control.example',
        AGENTOS_API_TOKEN: token,
      },
      fetch,
    });

    expect(await runCli(['runs', 'list'], failure.io)).toBe(2);
    expect(failure.stderr.join('')).toContain('API token is invalid');
    expect(failure.stderr.join('')).not.toContain(token);
    expect(failure.stderr.join('')).not.toContain('smuggled-header');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never emits an untrusted remote error code in JSON output', async () => {
    const failure = capture({
      env: {
        AGENTOS_URL: 'https://control.example',
        AGENTOS_API_TOKEN: 'local-token',
      },
      fetch: vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'token=server-secret',
              message: 'request rejected',
            },
          },
          { status: 400 },
        ),
      ),
    });

    expect(await runCli(['--json', 'runs', 'list'], failure.io)).toBe(3);
    expect(JSON.parse(failure.stderr.join(''))).toMatchObject({
      error: { code: 'remote_error' },
    });
    expect(failure.stderr.join('')).not.toContain('server-secret');
  });

  it('scopes config plan and apply to the configuration binding', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'agentos-multi-project-')),
    );
    const path = join(root, 'agent-os.yaml');
    await writeFile(join(root, '.git'), 'gitdir: test\n');
    await writeFile(
      path,
      `
version: 1
project:
  name: local-two
  localPath: /workspaces/local-two
  defaultBranch: main
models:
  standard:
    provider: local
    model: test-model
    inputMicrodollarsPerMillionTokens: 0
    outputMicrodollarsPerMillionTokens: 0
    runtimeMicrodollarsPerMinute: 0
agents:
  implementer: { model: standard, environment: default }
environments:
  default: { runtime: process }
pipelines:
  feature: { steps: [{ id: implement, agent: implementer }] }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`,
    );
    const requests: Array<{ url: string; init: RequestInit | undefined }> =
      [];
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (init?.method === 'GET')
          return Response.json({ active: null, projectId: 'project_two' });
        return Response.json({
          projectId: 'project_two',
          digest: 'b'.repeat(64),
          revision: 1,
          appliedAt: '2026-08-20T12:00:00.000Z',
          provenance: {
            repositorySha: 'a'.repeat(40),
            configDigest: 'b'.repeat(64),
            modelDigest: 'c'.repeat(64),
            promptDigest: 'd'.repeat(64),
            environmentDigest: 'e'.repeat(64),
            policyDigest: 'f'.repeat(64),
          },
        });
      },
    );
    const shared = {
      fetch: fetch as typeof globalThis.fetch,
      cwd: root,
      env: { AGENTOS_URL: 'https://control.example', AGENTOS_API_TOKEN: 't' },
    };

    const apply = capture(shared);
    expect(
      await runCli(
        ['config', 'apply', '--config', path, '--idempotency-key', 'multi'],
        apply.io,
      ),
    ).toBe(0);
    expect(requests[0]?.url).toBe(
      `https://control.example/api/configuration?localPath=${encodeURIComponent('/workspaces/local-two')}`,
    );
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      projectId: 'project_two',
      expectedRevision: null,
      expectedDigest: null,
    });
  });

  it('scopes config plan to an unbound config by project name', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentos-name-project-')));
    const path = join(root, 'agent-os.yaml');
    await writeFile(join(root, '.git'), 'gitdir: test\n');
    await writeFile(path, STARTER_CONFIG);

    const requests: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      return Response.json({ active: null, projectId: 'project_example' });
    });
    const plan = capture({
      fetch: fetch as typeof globalThis.fetch,
      cwd: root,
      env: { AGENTOS_URL: 'https://control.example', AGENTOS_API_TOKEN: 't' },
    });

    await expect(
      runCli(['config', 'plan', '--config', path], plan.io),
    ).resolves.toBe(0);
    expect(requests[0]).toBe(
      'https://control.example/api/configuration?name=example',
    );
  });
});
