import { describe, expect, it, vi } from 'vitest';

import type {
  ManagedAgentsClient,
  ManagedAgentsEvent,
  ManagedAgentsRemoteAgent,
  ManagedAgentsRemoteEnvironment,
  ManagedAgentsRemoteSession,
} from './sdk-contract.js';
import {
  ManagedAgentsConflictError,
  ManagedAgentsLimitError,
  ManagedAgentsProviderError,
  createManagedAgentsRuntimeProvider,
  type ManagedAgentsRuntimeHandle,
} from './index.js';

const NOW = new Date('2026-08-17T12:00:00.000Z');

class FakeClock {
  current = NOW;

  now(): Date {
    return this.current;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class FakeManagedAgentsClient implements ManagedAgentsClient {
  readonly agentCreates: unknown[] = [];
  readonly agentUpdates: Array<{ id: string; params: unknown }> = [];
  readonly environmentCreates: unknown[] = [];
  readonly environmentUpdates: Array<{ id: string; params: unknown }> = [];
  readonly sessionCreates: unknown[] = [];
  readonly sentEvents: Array<{ id: string; params: unknown }> = [];
  readonly streamOptions: Array<{ signal?: AbortSignal } | undefined> = [];
  readonly archived: string[] = [];
  readonly deleted: string[] = [];
  readonly agents: ManagedAgentsRemoteAgent[] = [];
  readonly environments: ManagedAgentsRemoteEnvironment[] = [];
  readonly sessions = new Map<string, ManagedAgentsRemoteSession>();
  readonly eventHistory = new Map<string, ManagedAgentsEvent[]>();
  readonly streamBatches = new Map<
    string,
    Array<ManagedAgentsEvent[] | Error>
  >();
  failWith?: Error;

  readonly beta = {
    agents: {
      list: async () => this.iterate(this.agents),
      create: async (params: unknown) => {
        this.throwIfConfigured();
        this.agentCreates.push(params);
        const request = params as Record<string, unknown>;
        const created = remoteAgent({
          id: `agent_${this.agents.length + 1}`,
          version: 1,
          name: String(request.name),
          metadata: request.metadata as Record<string, string>,
        });
        this.agents.push(created);
        return created;
      },
      update: async (id: string, params: unknown) => {
        this.throwIfConfigured();
        this.agentUpdates.push({ id, params });
        const index = this.agents.findIndex((agent) => agent.id === id);
        if (index < 0) throw new Error('not found');
        const request = params as Record<string, unknown>;
        const updated = {
          ...this.agents[index]!,
          version: this.agents[index]!.version + 1,
          metadata: {
            ...this.agents[index]!.metadata,
            ...(request.metadata as Record<string, string>),
          },
        };
        this.agents[index] = updated;
        return updated;
      },
    },
    environments: {
      list: async () => this.iterate(this.environments),
      create: async (params: unknown) => {
        this.throwIfConfigured();
        this.environmentCreates.push(params);
        const request = params as Record<string, unknown>;
        const created = remoteEnvironment({
          id: `env_${this.environments.length + 1}`,
          name: String(request.name),
          metadata: request.metadata as Record<string, string>,
          config: request.config as ManagedAgentsRemoteEnvironment['config'],
        });
        this.environments.push(created);
        return created;
      },
      update: async (id: string, params: unknown) => {
        this.throwIfConfigured();
        this.environmentUpdates.push({ id, params });
        const index = this.environments.findIndex(
          (environment) => environment.id === id,
        );
        if (index < 0) throw new Error('not found');
        const request = params as Record<string, unknown>;
        const updated = {
          ...this.environments[index]!,
          config:
            (request.config as ManagedAgentsRemoteEnvironment['config']) ??
            this.environments[index]!.config,
          metadata: {
            ...this.environments[index]!.metadata,
            ...(request.metadata as Record<string, string>),
          },
        };
        this.environments[index] = updated;
        return updated;
      },
    },
    sessions: {
      create: async (params: unknown) => {
        this.throwIfConfigured();
        this.sessionCreates.push(params);
        const request = params as Record<string, unknown>;
        const agent = request.agent as { id: string; version: number };
        const session = remoteSession({
          id: `session_${this.sessionCreates.length}`,
          agent: { id: agent.id, version: agent.version },
          environment_id: String(request.environment_id),
          metadata: request.metadata as Record<string, string>,
        });
        this.sessions.set(session.id, session);
        this.eventHistory.set(session.id, []);
        return session;
      },
      retrieve: async (id: string) => {
        this.throwIfConfigured();
        const session = this.sessions.get(id);
        if (!session) throw new Error('not found');
        return session;
      },
      archive: async (id: string) => {
        this.throwIfConfigured();
        this.archived.push(id);
        const session = this.sessions.get(id);
        if (!session) throw new Error('not found');
        session.archived_at = NOW.toISOString();
        return session;
      },
      delete: async (id: string) => {
        this.throwIfConfigured();
        this.deleted.push(id);
        this.sessions.delete(id);
        return { id, type: 'session_deleted' as const };
      },
      events: {
        list: async (id: string) =>
          this.iterate(this.eventHistory.get(id) ?? []),
        stream: async (
          id: string,
          _params?: unknown,
          options?: { signal?: AbortSignal },
        ) => {
          this.streamOptions.push(options);
          const next = this.streamBatches.get(id)?.shift() ?? [];
          if (next instanceof Error) throw next;
          return this.iterate(next);
        },
        send: async (id: string, params: unknown) => {
          this.throwIfConfigured();
          this.sentEvents.push({ id, params });
          return { data: [] };
        },
      },
    },
  };

  private async *iterate<T>(items: readonly T[]): AsyncIterable<T> {
    for (const item of items) yield item;
  }

  private throwIfConfigured(): void {
    if (this.failWith) throw this.failWith;
  }
}

function remoteAgent(
  overrides: Partial<ManagedAgentsRemoteAgent> = {},
): ManagedAgentsRemoteAgent {
  return {
    id: 'agent_1',
    type: 'agent',
    name: 'agentos:writer',
    model: { id: 'claude-sonnet-4-6' },
    system: null,
    tools: [],
    mcp_servers: [],
    metadata: {},
    version: 1,
    archived_at: null,
    ...overrides,
  };
}

function remoteEnvironment(
  overrides: Partial<ManagedAgentsRemoteEnvironment> = {},
): ManagedAgentsRemoteEnvironment {
  return {
    id: 'env_1',
    type: 'environment',
    name: 'agentos:node',
    description: '',
    metadata: {},
    config: {
      type: 'cloud',
      networking: {
        type: 'limited',
        allowed_hosts: [],
        allow_mcp_servers: false,
        allow_package_managers: false,
      },
      packages: { npm: [], pip: [] },
    },
    archived_at: null,
    ...overrides,
  };
}

function remoteSession(
  overrides: Partial<ManagedAgentsRemoteSession> = {},
): ManagedAgentsRemoteSession {
  return {
    id: 'session_1',
    type: 'session',
    agent: { id: 'agent_1', version: 1 },
    environment_id: 'env_1',
    metadata: {},
    status: 'idle',
    resources: [],
    archived_at: null,
    usage: {},
    stats: {},
    ...overrides,
  };
}

function messageEvent(
  id: string,
  text: string,
  fingerprint?: string,
): ManagedAgentsEvent {
  return {
    id,
    type: 'agent.message',
    processed_at: NOW.toISOString(),
    content: [{ type: 'text', text }],
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}

const agent = {
  id: 'writer',
  model: 'claude-sonnet-4-6',
  instructions: 'Write concise code.',
  tools: ['read', 'write'],
  mcps: ['https://mcp.example.test/api'],
};

const environment = {
  id: 'node',
  runtime: 'cloud',
  variables: {},
};

async function syncedProvider(
  client = new FakeManagedAgentsClient(),
  options: Record<string, unknown> = {},
) {
  const provider = await createManagedAgentsRuntimeProvider({
    apiKey: 'test-key',
    client,
    clock: new FakeClock(),
    ...options,
  });
  await provider.syncAgent(agent);
  await provider.syncEnvironment(environment);
  return { client, provider };
}

describe('managed agents factory', () => {
  it.each([
    [{ apiKey: '' }, 'apiKey is required'],
    [{ apiKey: 'key', baseURL: 'javascript:alert(1)' }, 'baseURL'],
    [{ apiKey: 'key', requestTimeoutMs: 0 }, 'requestTimeoutMs'],
    [{ apiKey: 'key', requestTimeoutMs: 300_001 }, 'requestTimeoutMs'],
  ])(
    'validates configuration before constructing a client',
    async (options, error) => {
      const clientFactory = vi.fn();
      await expect(
        createManagedAgentsRuntimeProvider({ ...options, clientFactory }),
      ).rejects.toThrow(error);
      expect(clientFactory).not.toHaveBeenCalled();
    },
  );

  it('has no live-call requirement when a client is injected', async () => {
    const client = new FakeManagedAgentsClient();
    await createManagedAgentsRuntimeProvider({ apiKey: 'key', client });
    expect(client.agentCreates).toEqual([]);
  });

  it('redacts provider messages and credentials', async () => {
    const client = new FakeManagedAgentsClient();
    client.failWith = Object.assign(
      new Error('request failed for sk-ant-secret at /private/path'),
      { code: 'sk-ant-secret', type: 'timeout_error' },
    );
    const provider = await createManagedAgentsRuntimeProvider({
      apiKey: 'sk-ant-secret',
      client,
    });

    const error = await provider
      .syncAgent(agent)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManagedAgentsProviderError);
    expect(String(error)).toBe(
      'ManagedAgentsProviderError: Provider request failed',
    );
    expect(String(error)).not.toContain('secret');
    expect(String(error)).not.toContain('/private/path');
    expect((error as ManagedAgentsProviderError).code).toBe('timeout_error');
  });
});

describe('declarative resource sync', () => {
  it('creates resources with stable-id and digest metadata and limited networking', async () => {
    const { client } = await syncedProvider();

    expect(client.agentCreates).toEqual([
      expect.objectContaining({
        name: 'agentos:writer',
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'mcp_toolset',
            default_config: {
              enabled: true,
              permission_policy: { type: 'always_ask' },
            },
          }),
        ]),
        metadata: expect.objectContaining({
          'agentos.local_id': 'writer',
          'agentos.config_digest': expect.stringMatching(/^sha256:/),
        }),
      }),
    ]);
    expect(client.environmentCreates).toEqual([
      expect.objectContaining({
        name: 'agentos:node',
        config: expect.objectContaining({
          type: 'cloud',
          networking: expect.objectContaining({ type: 'limited' }),
        }),
        metadata: expect.objectContaining({
          'agentos.local_id': 'node',
          'agentos.config_digest': expect.stringMatching(/^sha256:/),
        }),
      }),
    ]);
  });

  it('is idempotent when remote digests match', async () => {
    const { client, provider } = await syncedProvider();
    await provider.syncAgent(agent);
    await provider.syncEnvironment(environment);
    expect(client.agentCreates).toHaveLength(1);
    expect(client.agentUpdates).toEqual([]);
    expect(client.environmentCreates).toHaveLength(1);
    expect(client.environmentUpdates).toEqual([]);
  });

  it('updates agents optimistically and writes environment digests', async () => {
    const { client, provider } = await syncedProvider();
    await provider.syncAgent({ ...agent, instructions: 'Changed.' });
    await provider.syncEnvironment({
      ...environment,
      networking: { type: 'limited', allowedHosts: ['example.test'] },
    });

    expect(client.agentUpdates[0]).toEqual({
      id: 'agent_1',
      params: expect.objectContaining({
        version: 1,
        metadata: expect.objectContaining({
          'agentos.config_digest': expect.stringMatching(/^sha256:/),
        }),
      }),
    });
    expect(client.environmentUpdates[0]).toEqual({
      id: 'env_1',
      params: expect.objectContaining({
        metadata: expect.objectContaining({
          'agentos.config_digest': expect.stringMatching(/^sha256:/),
        }),
      }),
    });
  });

  it('detects duplicate remote resources and conflicting config ownership', async () => {
    const duplicateClient = new FakeManagedAgentsClient();
    duplicateClient.agents.push(
      remoteAgent({ metadata: { 'agentos.local_id': 'writer' } }),
      remoteAgent({
        id: 'agent_2',
        metadata: { 'agentos.local_id': 'writer' },
      }),
    );
    const duplicateProvider = await createManagedAgentsRuntimeProvider({
      apiKey: 'key',
      client: duplicateClient,
    });
    await expect(duplicateProvider.syncAgent(agent)).rejects.toBeInstanceOf(
      ManagedAgentsConflictError,
    );

    const conflictClient = new FakeManagedAgentsClient();
    conflictClient.agents.push(
      remoteAgent({
        name: 'owned-elsewhere',
        metadata: {
          'agentos.local_id': 'writer',
          'agentos.owner': 'another-system',
        },
      }),
    );
    const conflictProvider = await createManagedAgentsRuntimeProvider({
      apiKey: 'key',
      client: conflictClient,
    });
    await expect(conflictProvider.syncAgent(agent)).rejects.toBeInstanceOf(
      ManagedAgentsConflictError,
    );
  });

  it('maps optimistic agent version conflicts to a redacted sync conflict', async () => {
    const client = new FakeManagedAgentsClient();
    client.agents.push(
      remoteAgent({
        metadata: {
          'agentos.local_id': 'writer',
          'agentos.config_digest': 'sha256:stale',
          'agentos.owner': 'agentos-managed-agents-runtime',
        },
      }),
    );
    const provider = await createManagedAgentsRuntimeProvider({
      apiKey: 'key',
      client,
    });
    const conflict = Object.assign(new Error('remote payload with secret'), {
      status: 409,
    });
    client.failWith = conflict;

    const error = await provider
      .syncAgent(agent)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManagedAgentsConflictError);
    expect(String(error)).not.toContain('secret');
  });

  it('refuses to adopt a matching remote resource without the exact owner marker', async () => {
    const client = new FakeManagedAgentsClient();
    client.agents.push(
      remoteAgent({
        metadata: {
          'agentos.local_id': 'writer',
          'agentos.config_digest': 'sha256:legacy',
        },
      }),
    );
    const provider = await createManagedAgentsRuntimeProvider({
      apiKey: 'key',
      client,
    });

    await expect(provider.syncAgent(agent)).rejects.toBeInstanceOf(
      ManagedAgentsConflictError,
    );
    expect(client.agentUpdates).toEqual([]);
  });

  it.each([
    [{ ...environment, runtime: 'docker' }, 'runtime'],
    [{ ...environment, image: 'node:24' }, 'image'],
    [{ ...environment, variables: { TOKEN: 'secret' } }, 'variables'],
  ])(
    'rejects environment fields the provider cannot provision',
    async (value, field) => {
      const provider = await createManagedAgentsRuntimeProvider({
        apiKey: 'key',
        client: new FakeManagedAgentsClient(),
      });
      await expect(provider.syncEnvironment(value)).rejects.toThrow(field);
    },
  );

  it('rejects unrestricted networking without an explicit policy override', async () => {
    const provider = await createManagedAgentsRuntimeProvider({
      apiKey: 'key',
      client: new FakeManagedAgentsClient(),
    });
    await expect(
      provider.syncEnvironment({
        ...environment,
        networking: { type: 'unrestricted' },
      }),
    ).rejects.toThrow('unrestricted networking is disabled');

    const allowed = await createManagedAgentsRuntimeProvider({
      apiKey: 'key',
      client: new FakeManagedAgentsClient(),
      allowUnrestrictedNetworking: true,
    });
    await expect(
      allowed.syncEnvironment({
        ...environment,
        networking: { type: 'unrestricted' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('sessions and controls', () => {
  it('pins exact agent/environment IDs and sends metadata, input, and resources', async () => {
    const { client, provider } = await syncedProvider();
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      roleId: 'implementer',
      agentId: 'writer',
      environmentId: 'node',
      input: { task: 'Implement it' },
      resources: [
        { type: 'file', fileId: 'file_1', mountPath: '/workspace/spec.md' },
        {
          type: 'source_snapshot',
          repositoryUrl: 'https://github.com/example/repo',
          commitSha: '0123456789abcdef',
          authorizationToken: 'github-secret',
          mountPath: '/workspace/repo',
        },
      ],
    });

    expect(handle).toMatchObject({
      id: 'session_1',
      agentId: 'agent_1',
      agentVersion: 1,
      environmentId: 'env_1',
    });
    expect(client.sessionCreates[0]).toEqual(
      expect.objectContaining({
        agent: { type: 'agent', id: 'agent_1', version: 1 },
        environment_id: 'env_1',
        metadata: expect.objectContaining({
          'agentos.run_id': 'run-1',
          'agentos.step_id': 'step-1',
          'agentos.role_id': 'implementer',
          'agentos.agent_digest': expect.stringMatching(/^sha256:/),
          'agentos.environment_digest': expect.stringMatching(/^sha256:/),
        }),
        initial_events: [
          {
            type: 'user.message',
            content: [{ type: 'text', text: '{"task":"Implement it"}' }],
          },
        ],
        resources: [
          { type: 'file', file_id: 'file_1', mount_path: '/workspace/spec.md' },
          {
            type: 'github_repository',
            url: 'https://github.com/example/repo',
            authorization_token: 'github-secret',
            checkout: { type: 'commit', sha: '0123456789abcdef' },
            mount_path: '/workspace/repo',
          },
        ],
      }),
    );
  });

  it('always creates separate sessions, including distinct roles', async () => {
    const { client, provider } = await syncedProvider();
    const base = {
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    };
    const first = await provider.start({ ...base, roleId: 'builder' });
    const second = await provider.start({ ...base, roleId: 'reviewer' });
    expect(first.id).not.toBe(second.id);
    expect(client.sessionCreates).toHaveLength(2);
  });

  it('sends user messages, custom-tool results, resume input, and interrupts', async () => {
    const { client, provider } = await syncedProvider();
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });
    await provider.send(handle, 'follow up');
    await provider.send(handle, {
      type: 'custom_tool_result',
      toolUseId: 'evt-tool',
      content: { ok: true },
    });
    await provider.send(handle, {
      type: 'tool_confirmation',
      toolUseId: 'evt-mcp',
      result: 'allow',
    });
    await provider.resume(handle, 'continue');
    await provider.cancel(handle, 'stop now');

    expect(client.sentEvents.map((entry) => entry.params)).toEqual([
      {
        events: [
          {
            type: 'user.message',
            content: [{ type: 'text', text: 'follow up' }],
          },
        ],
      },
      {
        events: [
          {
            type: 'user.custom_tool_result',
            custom_tool_use_id: 'evt-tool',
            content: [{ type: 'text', text: '{"ok":true}' }],
          },
        ],
      },
      {
        events: [
          {
            type: 'user.tool_confirmation',
            tool_use_id: 'evt-mcp',
            result: 'allow',
          },
        ],
      },
      {
        events: [
          {
            type: 'user.message',
            content: [{ type: 'text', text: 'continue' }],
          },
        ],
      },
      { events: [{ type: 'user.interrupt' }] },
    ]);
  });

  it('rejects unbounded session resource collections before a live call', async () => {
    const { client, provider } = await syncedProvider(undefined, {
      limits: { maxRemoteResources: 1 },
    });

    await expect(
      provider.start({
        runId: 'run-1',
        stepId: 'step-1',
        agentId: 'writer',
        environmentId: 'node',
        input: 'work',
        resources: [
          { type: 'file', fileId: 'file-1' },
          { type: 'file', fileId: 'file-2' },
        ],
      }),
    ).rejects.toBeInstanceOf(ManagedAgentsLimitError);
    expect(client.sessionCreates).toEqual([]);
  });
});

describe('bounded normalization, replay, output, and usage', () => {
  it('replays history, reconnects streams, and deduplicates provider IDs', async () => {
    const { client, provider } = await syncedProvider(undefined, {
      limits: { maxStreamReconnects: 2 },
    });
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });
    client.eventHistory.set(handle.id, [messageEvent('evt-1', 'one', 'fp-1')]);
    client.streamBatches.set(handle.id, [
      [messageEvent('evt-1', 'one'), messageEvent('evt-2', 'two')],
      new Error('disconnect'),
      [messageEvent('evt-2', 'two'), messageEvent('evt-3', 'three')],
    ]);

    const events = [];
    for await (const event of provider.events(handle)) events.push(event);

    expect(events.map((event) => event.id)).toEqual([
      'evt-1',
      'evt-2',
      'evt-3',
    ]);
    expect(events[0]).toMatchObject({
      type: 'message',
      payload: { text: 'one', providerFingerprint: 'fp-1' },
    });
  });

  it('deduplicates provider IDs repeated across paginated history', async () => {
    const { client, provider } = await syncedProvider();
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });
    client.eventHistory.set(handle.id, [
      messageEvent('evt-1', 'one'),
      messageEvent('evt-1', 'one'),
      messageEvent('evt-2', 'two'),
    ]);

    await expect(provider.listEvents(handle)).resolves.toMatchObject([
      { id: 'evt-1' },
      { id: 'evt-2' },
    ]);
  });

  it('passes an abort signal that bounds every stream connection', async () => {
    const { client, provider } = await syncedProvider(undefined, {
      limits: { maxStreamDurationMs: 50, maxStreamReconnects: 0 },
    });
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });

    const iterator = provider.events(handle)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(client.streamOptions).toHaveLength(1);
    expect(client.streamOptions[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps statuses distinctly and fails closed for malformed or unknown events', async () => {
    const { client, provider } = await syncedProvider();
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });
    client.eventHistory.set(handle.id, [
      {
        id: 'idle-action',
        type: 'session.status_idle',
        processed_at: NOW.toISOString(),
        stop_reason: { type: 'requires_action', event_ids: ['tool-1'] },
      },
      {
        id: 'idle-retries',
        type: 'session.status_idle',
        processed_at: NOW.toISOString(),
        stop_reason: { type: 'retries_exhausted' },
      },
      {
        id: 'rescheduled',
        type: 'session.status_rescheduled',
        processed_at: NOW.toISOString(),
      },
      {
        id: 'terminated',
        type: 'session.status_terminated',
        processed_at: NOW.toISOString(),
      },
    ]);
    const normalized = await provider.listEvents(handle);
    expect(normalized.map((event) => event.type)).toEqual([
      'requires_action',
      'retries_exhausted',
      'rescheduling',
      'terminated',
    ]);

    client.eventHistory.set(handle.id, [
      { id: 'unknown', type: 'provider.new_secret_event', secret: 'nope' },
    ]);
    await expect(provider.listEvents(handle)).rejects.toThrow(
      'Unsupported provider event',
    );
    client.eventHistory.set(handle.id, [
      {
        id: 'bad',
        type: 'agent.message',
        processed_at: 'not-a-date',
        content: [],
      },
    ]);
    await expect(provider.listEvents(handle)).rejects.toThrow(
      'Malformed provider event',
    );
  });

  it('does not expose thinking, raw tool payloads, redacted blocks, or arbitrary errors', async () => {
    const { client, provider } = await syncedProvider();
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });
    client.eventHistory.set(handle.id, [
      {
        id: 'thinking',
        type: 'agent.thinking',
        processed_at: NOW.toISOString(),
        thinking: 'secret chain of thought',
      },
      {
        id: 'tool',
        type: 'agent.custom_tool_use',
        processed_at: NOW.toISOString(),
        name: 'lookup',
        input: { password: 'secret' },
      },
      {
        id: 'message',
        type: 'agent.message',
        processed_at: NOW.toISOString(),
        content: [
          { type: 'text', text: 'safe' },
          { type: 'redacted_thinking', data: 'secret' },
        ],
      },
      {
        id: 'error',
        type: 'session.error',
        processed_at: NOW.toISOString(),
        error: {
          type: 'unknown_error',
          message: 'token=secret',
          retry_status: { type: 'terminal' },
        },
      },
    ]);
    const serialized = JSON.stringify(await provider.listEvents(handle));
    expect(serialized).not.toContain('chain of thought');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('redacted');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).toContain('lookup');
    expect(serialized).toContain('safe');
  });

  it('allowlists official provider error codes and retry status without messages', async () => {
    const { client, provider } = await syncedProvider();
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });
    client.eventHistory.set(handle.id, [
      {
        id: 'overloaded',
        type: 'session.error',
        processed_at: NOW.toISOString(),
        error: {
          type: 'model_overloaded_error',
          message: 'sensitive provider detail',
          retry_status: { type: 'exhausted' },
        },
      },
    ]);

    await expect(provider.listEvents(handle)).resolves.toMatchObject([
      {
        id: 'overloaded',
        type: 'error',
        payload: {
          code: 'model_overloaded_error',
          retryStatus: 'exhausted',
        },
      },
    ]);
    expect(JSON.stringify(await provider.listEvents(handle))).not.toContain(
      'sensitive provider detail',
    );
  });

  it('uses the injected clock when acknowledged user events omit processed_at', async () => {
    const { client, provider } = await syncedProvider();
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });
    client.eventHistory.set(handle.id, [
      { id: 'user-1', type: 'user.message', content: [] },
    ]);

    await expect(provider.listEvents(handle)).resolves.toMatchObject([
      {
        id: 'user-1',
        type: 'input_acknowledged',
        occurredAt: NOW,
      },
    ]);
  });

  it('collects bounded structured output and normalized cache-aware usage', async () => {
    const { client, provider } = await syncedProvider();
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });
    client.eventHistory.set(handle.id, [
      messageEvent('evt-1', '{"result":"ok"}'),
    ]);
    const session = client.sessions.get(handle.id)!;
    session.resources = [
      { id: 'resource-1', type: 'file', filename: 'report.json' },
    ];
    session.usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 4,
      cache_creation: {
        ephemeral_5m_input_tokens: 2,
        ephemeral_1h_input_tokens: 3,
      },
      active_seconds: 1.25,
      list_cost: { currency: 'USD', amount: '999.99' },
    };

    await expect(provider.collectOutput(handle)).resolves.toEqual({
      text: '{"result":"ok"}',
      data: { result: 'ok' },
      artifacts: [{ key: 'resource-1' }],
    });
    await expect(provider.usage(handle)).resolves.toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 5,
      runtimeMs: 1250,
    });
  });

  it('bounds pagination, stream duration, event bytes, and output collections', async () => {
    const { client, provider } = await syncedProvider(undefined, {
      limits: { maxListedEvents: 1, maxEventBytes: 100, maxOutputBytes: 8 },
    });
    const handle = await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    });
    client.eventHistory.set(handle.id, [
      messageEvent('one', '1'),
      messageEvent('two', '2'),
    ]);
    await expect(provider.listEvents(handle)).rejects.toBeInstanceOf(
      ManagedAgentsLimitError,
    );

    client.eventHistory.set(handle.id, [
      messageEvent('large', 'x'.repeat(200)),
    ]);
    await expect(provider.listEvents(handle)).rejects.toBeInstanceOf(
      ManagedAgentsLimitError,
    );

    client.eventHistory.set(handle.id, [messageEvent('output', '123456789')]);
    await expect(provider.collectOutput(handle)).rejects.toBeInstanceOf(
      ManagedAgentsLimitError,
    );
  });
});

describe('status and cleanup', () => {
  it.each(['running', 'idle', 'rescheduling', 'terminated'] as const)(
    'retrieves the %s status',
    async (status) => {
      const { client, provider } = await syncedProvider();
      const handle = await provider.start({
        runId: 'run-1',
        stepId: 'step-1',
        agentId: 'writer',
        environmentId: 'node',
        input: 'work',
      });
      client.sessions.get(handle.id)!.status = status;
      await expect(provider.status(handle)).resolves.toEqual({ status });
    },
  );

  it('interrupts a running session before archive/delete and cleanup is idempotent', async () => {
    const { client, provider } = await syncedProvider();
    const handle = (await provider.start({
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'writer',
      environmentId: 'node',
      input: 'work',
    })) as ManagedAgentsRuntimeHandle;
    client.sessions.get(handle.id)!.status = 'running';

    await provider.cleanup(handle);
    await provider.cleanup(handle);

    expect(client.sentEvents).toEqual([
      { id: handle.id, params: { events: [{ type: 'user.interrupt' }] } },
    ]);
    expect(client.archived).toEqual([handle.id]);
    expect(client.deleted).toEqual([handle.id]);
  });
});
