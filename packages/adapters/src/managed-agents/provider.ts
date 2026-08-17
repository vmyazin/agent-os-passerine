import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import type {
  Clock,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeOutput,
  RuntimeUsage,
} from '@agentos/core';

import {
  ManagedAgentsConfigurationError,
  ManagedAgentsConflictError,
  ManagedAgentsLimitError,
  ManagedAgentsProviderError,
} from './errors.js';
import {
  normalizeEvent,
  normalizeRuntimeMilliseconds,
} from './normalization.js';
import type {
  ManagedAgentsClient,
  ManagedAgentsEvent,
  ManagedAgentsRemoteSession,
} from './sdk-contract.js';
import type {
  ManagedAgentsCustomToolResult,
  ManagedAgentsSessionAccess,
  ManagedAgentsLimits,
  ManagedAgentsProvider,
  ManagedAgentsRuntimeEnvironment,
  ManagedAgentsRuntimeHandle,
  ManagedAgentsRuntimeProviderOptions,
  ManagedAgentsStartRequest,
  ManagedAgentsStatus,
  ManagedAgentsToolConfirmation,
} from './types.js';

const OWNER = 'agentos-managed-agents-runtime';
const LOCAL_ID = 'agentos.local_id';
const CONFIG_DIGEST = 'agentos.config_digest';
const OWNER_KEY = 'agentos.owner';
const SESSION_CAPABILITY_HASH = 'agentos.session_capability_hash';
const RUN_ID = 'agentos.run_id';
const STEP_ID = 'agentos.step_id';
const IDEMPOTENCY_KEY_HASH = 'agentos.idempotency_key_hash';
const SESSION_DEADLINE = 'agentos.session_deadline';
const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01' as const;
const WEB_EGRESS_TOOLS = new Set(['web_fetch', 'web_search']);
const BUILT_IN_TOOLS = new Set([
  'bash',
  'edit',
  'read',
  'write',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
]);

interface ResolvedAgent {
  id: string;
  version: number;
  digest: string;
  usesBuiltInWebEgress: boolean;
}

interface ResolvedEnvironment {
  id: string;
  digest: string;
  unrestrictedNetworking: boolean;
}

interface RequiredLimits {
  maxRemoteResources: number;
  maxListedEvents: number;
  maxEventBytes: number;
  maxOutputBytes: number;
  maxStreamDurationMs: number;
  maxStreamReconnects: number;
  streamReconnectDelayMs: number;
}

const DEFAULT_LIMITS: RequiredLimits = {
  maxRemoteResources: 1_000,
  maxListedEvents: 1_000,
  maxEventBytes: 256 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxStreamDurationMs: 21 * 60_000,
  maxStreamReconnects: 3,
  streamReconnectDelayMs: 100,
};

class ManagedAgentsRuntimeProvider implements ManagedAgentsProvider {
  readonly #client: ManagedAgentsClient;
  readonly #clock: Clock;
  readonly #limits: RequiredLimits;
  readonly #allowUnrestrictedNetworking: boolean;
  readonly #allowBuiltInWebEgress: boolean;
  readonly #ownershipSecret: string;
  readonly #agents = new Map<string, ResolvedAgent>();
  readonly #environments = new Map<string, ResolvedEnvironment>();
  readonly #cleanedSessions = new Set<string>();
  readonly #agentSyncs = new Map<string, Promise<void>>();
  readonly #environmentSyncs = new Map<string, Promise<void>>();

  constructor(
    client: ManagedAgentsClient,
    clock: Clock,
    limits: RequiredLimits,
    allowUnrestrictedNetworking: boolean,
    allowBuiltInWebEgress: boolean,
    ownershipSecret: string,
  ) {
    this.#client = client;
    this.#clock = clock;
    this.#limits = limits;
    this.#allowUnrestrictedNetworking = allowUnrestrictedNetworking;
    this.#allowBuiltInWebEgress = allowBuiltInWebEgress;
    this.#ownershipSecret = ownershipSecret;
  }

  async syncAgent(agent: RuntimeAgent): Promise<void> {
    validateLocalId(agent.id, 'agent.id');
    return this.#serializeSync(this.#agentSyncs, agent.id, () =>
      this.#syncAgent(agent),
    );
  }

  async provisionSessionAccess(input: {
    readonly idempotencyKey: string;
    readonly mcpUrl?: string;
    readonly bearerToken?: string;
    readonly files: readonly {
      filename: string;
      mediaType: string;
      bytes: Uint8Array;
      mountPath: string;
    }[];
  }): Promise<ManagedAgentsSessionAccess> {
    validateLocalId(input.idempotencyKey, 'access.idempotencyKey');
    if ((input.mcpUrl === undefined) !== (input.bearerToken === undefined))
      throw new ManagedAgentsConfigurationError(
        'MCP URL and bearer capability must be provided together',
      );
    const keyHash = createHash('sha256')
      .update(input.idempotencyKey)
      .digest('hex');
    const resources = [] as Array<{
      type: 'file';
      fileId: string;
      mountPath: string;
    }>;
    const listedFiles = await this.#wrap(async () =>
      collectBounded(
        await this.#client.beta.files.list({ betas: [MANAGED_AGENTS_BETA] }),
        this.#limits.maxRemoteResources,
      ),
    );
    for (const file of input.files) {
      if (file.bytes.byteLength > this.#limits.maxOutputBytes)
        throw new ManagedAgentsLimitError('Access file exceeds maxOutputBytes');
      const contentHash = createHash('sha256').update(file.bytes).digest('hex');
      const filename = `agentos-${keyHash.slice(0, 16)}-${contentHash.slice(0, 16)}-${safeFilename(file.filename)}`;
      const matches = listedFiles.filter(
        (candidate) =>
          candidate.filename === filename &&
          candidate.size_bytes === file.bytes.byteLength &&
          candidate.mime_type === file.mediaType,
      );
      if (matches.length > 1)
        throw new ManagedAgentsConflictError(
          'Duplicate Managed Agent access files',
        );
      const remote =
        matches[0] ??
        (await this.#wrap(() =>
          this.#client.beta.files.upload({
            file: new File(
              [
                file.bytes.buffer.slice(
                  file.bytes.byteOffset,
                  file.bytes.byteOffset + file.bytes.byteLength,
                ) as ArrayBuffer,
              ],
              filename,
              { type: file.mediaType },
            ),
            betas: [MANAGED_AGENTS_BETA],
          }),
        ));
      resources.push({
        type: 'file',
        fileId: remote.id,
        mountPath: file.mountPath,
      });
    }
    if (input.mcpUrl === undefined || input.bearerToken === undefined)
      return { resources, credentialRefs: [] };
    const mcpUrl = validatedMcpUrl(input.mcpUrl);
    const vaults = await this.#wrap(async () =>
      collectBounded(
        await this.#client.beta.vaults.list({
          include_archived: false,
          betas: [MANAGED_AGENTS_BETA],
        }),
        this.#limits.maxRemoteResources,
      ),
    );
    const matches = vaults.filter(
      (vault) =>
        vault.archived_at === null &&
        vault.metadata['agentos.access_key_hash'] === keyHash,
    );
    if (matches.length > 1)
      throw new ManagedAgentsConflictError(
        'Duplicate Managed Agent access vaults',
      );
    const vault =
      matches[0] ??
      (await this.#wrap(() =>
        this.#client.beta.vaults.create({
          display_name: `agentos:${input.idempotencyKey}`,
          metadata: {
            'agentos.owner': OWNER,
            'agentos.access_key_hash': keyHash,
          },
          betas: [MANAGED_AGENTS_BETA],
        }),
      ));
    const credentials = await this.#wrap(async () =>
      collectBounded(
        await this.#client.beta.vaults.credentials.list(vault.id, {
          include_archived: false,
          betas: [MANAGED_AGENTS_BETA],
        }),
        10,
      ),
    );
    const credentialMatches = credentials.filter(
      (credential) =>
        credential.archived_at === null &&
        credential.metadata['agentos.access_key_hash'] === keyHash,
    );
    if (credentialMatches.length > 1)
      throw new ManagedAgentsConflictError(
        'Duplicate Managed Agent MCP credentials',
      );
    if (credentialMatches.length === 0) {
      await this.#wrap(() =>
        this.#client.beta.vaults.credentials.create(vault.id, {
          auth: {
            type: 'static_bearer',
            token: input.bearerToken!,
            mcp_server_url: mcpUrl,
          },
          display_name: 'AgentOS scoped Artifact MCP capability',
          metadata: { 'agentos.access_key_hash': keyHash },
          betas: [MANAGED_AGENTS_BETA],
        }),
      );
    }
    return { resources, credentialRefs: [vault.id] };
  }

  async #syncAgent(agent: RuntimeAgent): Promise<void> {
    const usesBuiltInWebEgress = agent.tools.some((tool) =>
      WEB_EGRESS_TOOLS.has(tool),
    );
    if (usesBuiltInWebEgress && !this.#allowBuiltInWebEgress) {
      throw new ManagedAgentsConfigurationError(
        'built-in web egress is disabled by policy',
      );
    }
    const definition = agentDefinition(agent);
    const digest = configDigest(definition);
    await this.#wrap(async () => {
      const remotes = await collectBounded(
        await this.#client.beta.agents.list({ include_archived: false }),
        this.#limits.maxRemoteResources,
      );
      let remote = findOwnedResource(remotes, agent.id, `agentos:${agent.id}`);
      if (remote === undefined) {
        try {
          const created = await this.#client.beta.agents.create({
            ...definition,
            metadata: metadataFor(agent.id, digest),
          });
          this.#agents.set(agent.id, {
            id: created.id,
            version: created.version,
            digest,
            usesBuiltInWebEgress,
          });
          return;
        } catch (error) {
          if (!isConflictResponse(error)) throw error;
          const reconciled = await collectBounded(
            await this.#client.beta.agents.list({ include_archived: false }),
            this.#limits.maxRemoteResources,
          );
          remote = findOwnedResource(
            reconciled,
            agent.id,
            `agentos:${agent.id}`,
          );
          if (remote === undefined) throw error;
        }
      }
      assertOwnership(remote.metadata);
      if (remote.metadata[CONFIG_DIGEST] === digest) {
        this.#agents.set(agent.id, {
          id: remote.id,
          version: remote.version,
          digest,
          usesBuiltInWebEgress,
        });
        return;
      }
      const updated = await this.#client.beta.agents.update(remote.id, {
        ...definition,
        metadata: metadataFor(agent.id, digest),
        version: remote.version,
      });
      this.#agents.set(agent.id, {
        id: updated.id,
        version: updated.version,
        digest,
        usesBuiltInWebEgress,
      });
    }, true);
  }

  async syncEnvironment(
    environment: ManagedAgentsRuntimeEnvironment,
  ): Promise<void> {
    validateLocalId(environment.id, 'environment.id');
    return this.#serializeSync(this.#environmentSyncs, environment.id, () =>
      this.#syncEnvironment(environment),
    );
  }

  async #syncEnvironment(
    environment: ManagedAgentsRuntimeEnvironment,
  ): Promise<void> {
    const managed = environment;
    validateEnvironmentFields(managed);
    if (
      managed.networking?.type === 'unrestricted' &&
      !this.#allowUnrestrictedNetworking
    ) {
      throw new ManagedAgentsConfigurationError(
        'unrestricted networking is disabled by policy',
      );
    }
    const definition = environmentDefinition(managed);
    const digest = configDigest({
      ...definition,
      runtime: environment.runtime,
      image: environment.image,
      variables: environment.variables,
    });
    await this.#wrap(async () => {
      const remotes = await collectBounded(
        await this.#client.beta.environments.list({ include_archived: false }),
        this.#limits.maxRemoteResources,
      );
      let remote = findOwnedResource(
        remotes,
        environment.id,
        `agentos:${environment.id}`,
      );
      if (remote === undefined) {
        try {
          const created = await this.#client.beta.environments.create({
            name: `agentos:${environment.id}`,
            description: `AgentOS environment ${environment.id}`,
            config: definition,
            metadata: metadataFor(environment.id, digest),
          });
          this.#environments.set(environment.id, {
            id: created.id,
            digest,
            unrestrictedNetworking: isUnrestricted(environment),
          });
          return;
        } catch (error) {
          if (!isConflictResponse(error)) throw error;
          const reconciled = await collectBounded(
            await this.#client.beta.environments.list({
              include_archived: false,
            }),
            this.#limits.maxRemoteResources,
          );
          remote = findOwnedResource(
            reconciled,
            environment.id,
            `agentos:${environment.id}`,
          );
          if (remote === undefined) throw error;
        }
      }
      assertOwnership(remote.metadata);
      if (remote.metadata[CONFIG_DIGEST] === digest) {
        this.#environments.set(environment.id, {
          id: remote.id,
          digest,
          unrestrictedNetworking: isUnrestricted(environment),
        });
        return;
      }
      const updated = await this.#client.beta.environments.update(remote.id, {
        name: `agentos:${environment.id}`,
        description: `AgentOS environment ${environment.id}`,
        config: definition,
        metadata: metadataFor(environment.id, digest),
      });
      this.#environments.set(environment.id, {
        id: updated.id,
        digest,
        unrestrictedNetworking: isUnrestricted(environment),
      });
    }, true);
  }

  async start(
    request: ManagedAgentsStartRequest,
  ): Promise<ManagedAgentsRuntimeHandle> {
    const managed = request;
    const agent = this.#agents.get(request.agentId);
    const environment = this.#environments.get(request.environmentId);
    if (agent === undefined) {
      throw new ManagedAgentsConfigurationError(
        'agent must be synced before start',
      );
    }
    if (environment === undefined) {
      throw new ManagedAgentsConfigurationError(
        'environment must be synced before start',
      );
    }
    if (agent.usesBuiltInWebEgress && !environment.unrestrictedNetworking) {
      throw new ManagedAgentsConfigurationError(
        'built-in web tools require unrestricted networking',
      );
    }
    validateLocalId(request.runId, 'runId');
    validateLocalId(request.stepId, 'stepId');
    const input = boundedText(
      request.input,
      this.#limits.maxEventBytes,
      'input',
    );
    if ((managed.resources?.length ?? 0) > this.#limits.maxRemoteResources) {
      throw new ManagedAgentsLimitError('Session resource limit exceeded');
    }
    const resources = (managed.resources ?? []).map(mapResource);
    const deadlineAt =
      request.timeoutMs === undefined
        ? undefined
        : new Date(
            this.#clock.now().getTime() + request.timeoutMs,
          ).toISOString();
    const budget = managedBudget(request.maxCostMicrodollars);
    const ownershipCapability = this.#sessionCapability(request);
    const session = await this.#wrap(() =>
      this.#client.beta.sessions.create({
        agent: { type: 'agent', id: agent.id, version: agent.version },
        environment_id: environment.id,
        metadata: {
          [RUN_ID]: request.runId,
          [STEP_ID]: request.stepId,
          ...(managed.roleId === undefined
            ? {}
            : { 'agentos.role_id': managed.roleId }),
          'agentos.agent_digest': agent.digest,
          'agentos.environment_digest': environment.digest,
          [SESSION_CAPABILITY_HASH]: hashCapability(ownershipCapability),
          ...(request.idempotencyKey === undefined
            ? {}
            : {
                [IDEMPOTENCY_KEY_HASH]: hashCapability(request.idempotencyKey),
              }),
          ...(deadlineAt === undefined
            ? {}
            : { [SESSION_DEADLINE]: deadlineAt }),
        },
        initial_events: [userMessage(input)],
        resources,
        ...(request.credentialRefs === undefined
          ? {}
          : { vault_ids: [...request.credentialRefs] }),
        ...(budget === undefined ? {} : { budget }),
      }),
    );
    return {
      id: session.id,
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: environment.id,
      runId: request.runId,
      stepId: request.stepId,
      ownershipCapability,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...(request.credentialRefs === undefined
        ? {}
        : { credentialRefs: [...request.credentialRefs] }),
      ...(resources.length === 0
        ? {}
        : { uploadedFileIds: resources.map((resource) => resource.file_id) }),
    };
  }

  async reconcileStart(
    request: ManagedAgentsStartRequest,
  ): Promise<ManagedAgentsRuntimeHandle | undefined> {
    if (request.idempotencyKey === undefined)
      throw new ManagedAgentsConfigurationError(
        'idempotencyKey is required to reconcile a session start',
      );
    const list = this.#client.beta.sessions.list;
    if (list === undefined)
      throw new ManagedAgentsConfigurationError(
        'Managed Agents session listing is required for start reconciliation',
      );
    const capability = this.#sessionCapability(request);
    const expectedKeyHash = hashCapability(request.idempotencyKey);
    const matches: ManagedAgentsRemoteSession[] = [];
    const sessions = await this.#wrap(() =>
      list.call(this.#client.beta.sessions, {}),
    );
    for await (const session of sessions) {
      if (
        session.metadata[RUN_ID] === request.runId &&
        session.metadata[STEP_ID] === request.stepId &&
        session.metadata[IDEMPOTENCY_KEY_HASH] === expectedKeyHash
      )
        matches.push(session);
    }
    if (matches.length > 1)
      throw new ManagedAgentsConflictError(
        'Multiple sessions match one idempotent runtime start',
      );
    const session = matches[0];
    if (session === undefined) return undefined;
    const handle: ManagedAgentsRuntimeHandle = {
      id: session.id,
      agentId: session.agent.id,
      agentVersion: session.agent.version,
      environmentId: session.environment_id,
      runId: request.runId,
      stepId: request.stepId,
      ownershipCapability: capability,
      ...(session.metadata[SESSION_DEADLINE] === undefined
        ? {}
        : { deadlineAt: validDeadline(session.metadata[SESSION_DEADLINE]) }),
      ...(session.vault_ids === undefined || session.vault_ids.length === 0
        ? {}
        : { credentialRefs: [...session.vault_ids] }),
      ...(session.resources.length === 0
        ? {}
        : {
            uploadedFileIds: session.resources
              .filter((resource) => resource.type === 'file')
              .map((resource) => resource.id),
          }),
    };
    assertSessionOwnership(handle, session.metadata);
    return handle;
  }

  #sessionCapability(request: ManagedAgentsStartRequest): string {
    if (request.idempotencyKey === undefined) return randomToken();
    return createHmac('sha256', this.#ownershipSecret)
      .update(
        canonicalJson({
          version: 'managed-session-capability-v1',
          runId: request.runId,
          stepId: request.stepId,
          idempotencyKey: request.idempotencyKey,
        }),
      )
      .digest('base64url');
  }

  async *events(handle: RuntimeHandle): AsyncIterable<RuntimeEvent> {
    const seen = new Set<string>();
    const startedAt = this.#clock.now().getTime();
    const hardDeadline =
      isManagedHandle(handle) && handle.deadlineAt !== undefined
        ? Date.parse(handle.deadlineAt)
        : startedAt + this.#limits.maxStreamDurationMs;
    const streamDeadline = Math.min(
      hardDeadline,
      startedAt + this.#limits.maxStreamDurationMs,
    );
    for (
      let connection = 0;
      connection <= this.#limits.maxStreamReconnects;
      connection += 1
    ) {
      for (const event of await this.listEvents(handle)) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          if (seen.size > this.#limits.maxListedEvents) {
            throw new ManagedAgentsLimitError(
              'Event collection limit exceeded',
            );
          }
          yield event;
        }
      }
      if (this.#clock.now().getTime() >= streamDeadline) {
        throw new ManagedAgentsLimitError('Stream exceeds maxStreamDurationMs');
      }
      const remainingMs = Math.max(
        1,
        streamDeadline - this.#clock.now().getTime(),
      );
      const signal = AbortSignal.timeout(remainingMs);
      try {
        const stream = await this.#client.beta.sessions.events.stream(
          handle.id,
          undefined,
          { signal },
        );
        for await (const providerEvent of stream) {
          if (this.#clock.now().getTime() >= streamDeadline) {
            throw new ManagedAgentsLimitError(
              'Stream exceeds maxStreamDurationMs',
            );
          }
          const event = normalizeEvent(
            providerEvent,
            this.#limits.maxEventBytes,
            this.#clock.now(),
          );
          if (event !== undefined && !seen.has(event.id)) {
            seen.add(event.id);
            if (seen.size > this.#limits.maxListedEvents) {
              throw new ManagedAgentsLimitError(
                'Event collection limit exceeded',
              );
            }
            yield event;
          }
        }
      } catch (error) {
        if (isLocalError(error)) throw error;
        if (signal.aborted) {
          throw new ManagedAgentsLimitError(
            'Stream exceeds maxStreamDurationMs',
          );
        }
        if (connection === this.#limits.maxStreamReconnects) {
          throw new ManagedAgentsProviderError(error);
        }
      }
      if (connection < this.#limits.maxStreamReconnects) {
        await this.#clock.sleep(this.#limits.streamReconnectDelayMs);
      }
    }
  }

  async listEvents(handle: RuntimeHandle): Promise<readonly RuntimeEvent[]> {
    return this.#listEvents(handle);
  }

  async #listEvents(
    handle: RuntimeHandle,
    maxOutputBytes?: number,
  ): Promise<readonly RuntimeEvent[]> {
    return this.#wrap(async () => {
      const result: RuntimeEvent[] = [];
      const seen = new Set<string>();
      let listedCount = 0;
      let outputBytes = 0;
      let outputMessages = 0;
      const source = await this.#client.beta.sessions.events.list(handle.id, {
        order: 'asc',
      });
      for await (const providerEvent of source) {
        listedCount += 1;
        if (listedCount > this.#limits.maxListedEvents) {
          throw new ManagedAgentsLimitError('Event collection limit exceeded');
        }
        const event = normalizeEvent(
          providerEvent,
          this.#limits.maxEventBytes,
          this.#clock.now(),
        );
        if (event !== undefined && !seen.has(event.id)) {
          if (maxOutputBytes !== undefined && event.type === 'message') {
            const text =
              isRecord(event.payload) && typeof event.payload.text === 'string'
                ? event.payload.text
                : '';
            outputBytes +=
              Buffer.byteLength(text, 'utf8') + (outputMessages === 0 ? 0 : 1);
            outputMessages += 1;
            if (outputBytes > maxOutputBytes) {
              throw new ManagedAgentsLimitError(
                'Output exceeds maxOutputBytes',
              );
            }
          }
          seen.add(event.id);
          result.push(event);
        }
      }
      return result;
    });
  }

  async send(handle: RuntimeHandle, message: unknown): Promise<void> {
    const event = isCustomToolResult(message)
      ? customToolResult(message, this.#limits.maxEventBytes)
      : isToolConfirmation(message)
        ? toolConfirmation(message, this.#limits.maxEventBytes)
        : userMessage(
            boundedText(message, this.#limits.maxEventBytes, 'message'),
          );
    await this.#wrap(() =>
      this.#client.beta.sessions.events.send(handle.id, { events: [event] }),
    );
  }

  async resume(handle: RuntimeHandle, input?: unknown): Promise<void> {
    if (input === undefined) return;
    await this.send(handle, input);
  }

  async cancel(handle: RuntimeHandle, reason?: string): Promise<void> {
    // The provider interrupt event has no reason field. Deliberately do not place
    // caller text into metadata or logs where it could disclose sensitive input.
    void reason;
    await this.#interrupt(handle);
  }

  async collectOutput(handle: RuntimeHandle): Promise<RuntimeOutput> {
    const events = await this.#listEvents(handle, this.#limits.maxOutputBytes);
    const messages = events.filter((event) => event.type === 'message');
    const text = messages
      .map((event) =>
        isRecord(event.payload) && typeof event.payload.text === 'string'
          ? event.payload.text
          : '',
      )
      .join('\n');
    const files = await this.#wrap(async () =>
      collectBounded(
        await this.#client.beta.files.list({
          scope_id: handle.id,
          betas: [MANAGED_AGENTS_BETA],
        }),
        this.#limits.maxRemoteResources,
      ),
    );
    const data = parseStructuredOutput(text);
    return {
      ...(text.length === 0 ? {} : { text }),
      ...(data === undefined ? {} : { data }),
      artifacts: files.map((file) => normalizeOutputFile(file, handle.id)),
    };
  }

  async observeCommand(
    handle: RuntimeHandle,
    expectedCommand: string,
  ): Promise<{
    command: string;
    exitCode: number;
    startedAt: string;
    completedAt: string;
  }> {
    if (expectedCommand.length < 1 || expectedCommand.length > 8_000)
      throw new ManagedAgentsConfigurationError('expected command is invalid');
    await this.#ownedSession(handle);
    const source = await this.#wrap(() =>
      this.#client.beta.sessions.events.list(handle.id, { order: 'asc' }),
    );
    const events: ManagedAgentsEvent[] = [];
    for await (const event of source) {
      events.push(event);
      if (events.length > this.#limits.maxListedEvents)
        throw new ManagedAgentsLimitError('Event collection limit exceeded');
    }
    const uses = events.filter((event) => event.type === 'agent.tool_use');
    if (uses.length !== 1)
      throw new Error('trusted verification must execute exactly one tool');
    const use = uses[0]!;
    const input = isRecord(use.input) ? use.input : undefined;
    if (
      use.name !== 'bash' ||
      input?.command !== expectedCommand ||
      typeof use.id !== 'string' ||
      typeof use.processed_at !== 'string'
    )
      throw new Error('trusted verification command mismatch');
    const results = events.filter(
      (event) =>
        event.type === 'agent.tool_result' && event.tool_use_id === use.id,
    );
    if (results.length !== 1)
      throw new Error('trusted verification result is missing');
    const result = results[0]!;
    if (typeof result.processed_at !== 'string')
      throw new Error('trusted verification result is malformed');
    const content = rawTextContent(result.content);
    const exitMatches = [
      ...content.matchAll(/(?:^|\n)AGENTOS_EXIT_CODE=(\d{1,3})(?:\n|$)/g),
    ];
    if (exitMatches.length !== 1)
      throw new Error('trusted verification exit code is missing');
    const exitCode = Number(exitMatches[0]![1]);
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255)
      throw new Error('trusted verification exit code is invalid');
    const startedAt = validEventTimestamp(use.processed_at);
    const completedAt = validEventTimestamp(result.processed_at);
    if (Date.parse(completedAt) < Date.parse(startedAt))
      throw new Error('trusted verification timestamps are invalid');
    return { command: expectedCommand, exitCode, startedAt, completedAt };
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage> {
    const session = await this.#wrap(() =>
      this.#client.beta.sessions.retrieve(handle.id),
    );
    const cache = session.usage.cache_creation ?? {};
    const cache5m = nonnegative(cache.ephemeral_5m_input_tokens);
    const cache1h = nonnegative(cache.ephemeral_1h_input_tokens);
    const undifferentiatedCacheCreation = nonnegative(
      session.usage.cache_creation_input_tokens,
    );
    return {
      inputTokens: nonnegative(session.usage.input_tokens),
      outputTokens: nonnegative(session.usage.output_tokens),
      cacheReadInputTokens: nonnegative(session.usage.cache_read_input_tokens),
      cacheCreation5mInputTokens: cache5m,
      cacheCreation1hInputTokens:
        cache1h +
        (cache5m === 0 && cache1h === 0 ? undifferentiatedCacheCreation : 0),
      runtimeMs: normalizeRuntimeMilliseconds(
        session.usage.active_seconds ?? session.stats.active_seconds,
      ),
    };
  }

  async status(handle: RuntimeHandle): Promise<ManagedAgentsStatus> {
    const session = await this.#wrap(() =>
      this.#client.beta.sessions.retrieve(handle.id),
    );
    return { status: normalizeSessionStatus(session.status) };
  }

  async cleanup(handle: RuntimeHandle): Promise<void> {
    if (this.#cleanedSessions.has(handle.id)) return;
    let sessionFailure: unknown;
    try {
      let session = await this.#ownedSession(handle);
      let status = normalizeSessionStatus(session.status);
      if (status === 'running' || status === 'rescheduling') {
        await this.#sendInterrupt(handle.id);
        session = await this.#ownedSession(handle);
        status = normalizeSessionStatus(session.status);
      }
      if (status !== 'idle' && status !== 'terminated') {
        throw new Error('Session remained active after interrupt');
      }
      await this.#wrap(() => this.#client.beta.sessions.archive(handle.id));
      await this.#ownedSession(handle);
      await this.#wrap(() => this.#client.beta.sessions.delete(handle.id));
    } catch (error) {
      if (!isProviderNotFound(error)) sessionFailure = error;
      // A previous cleanup may have deleted the session before its local
      // checkpoint committed. Provider absence is the desired terminal state.
    }
    if (isManagedHandle(handle)) {
      await this.cleanupAccess({
        credentialRefs: handle.credentialRefs ?? [],
        resources: (handle.uploadedFileIds ?? []).map((fileId) => ({
          type: 'file' as const,
          fileId,
        })),
      });
    }
    if (sessionFailure !== undefined) throw sessionFailure;
    this.#cleanedSessions.add(handle.id);
  }

  async cleanupAccess(input: {
    readonly resources: readonly {
      readonly type: 'file';
      readonly fileId: string;
    }[];
    readonly credentialRefs: readonly string[];
  }): Promise<void> {
    for (const vaultId of input.credentialRefs) {
      await ignoreNotFound(() =>
        this.#wrap(() =>
          this.#client.beta.vaults.archive(vaultId, {
            betas: [MANAGED_AGENTS_BETA],
          }),
        ),
      );
      await ignoreNotFound(() =>
        this.#wrap(() =>
          this.#client.beta.vaults.delete(vaultId, {
            betas: [MANAGED_AGENTS_BETA],
          }),
        ),
      );
    }
    for (const resource of input.resources) {
      await ignoreNotFound(() =>
        this.#wrap(() =>
          this.#client.beta.files.delete(resource.fileId, {
            betas: [MANAGED_AGENTS_BETA],
          }),
        ),
      );
    }
  }

  async #interrupt(handle: RuntimeHandle): Promise<void> {
    await this.#ownedSession(handle);
    await this.#sendInterrupt(handle.id);
  }

  async #sendInterrupt(sessionId: string): Promise<void> {
    await this.#wrap(() =>
      this.#client.beta.sessions.events.send(sessionId, {
        events: [{ type: 'user.interrupt' }],
      }),
    );
  }

  async #ownedSession(
    handle: RuntimeHandle,
  ): Promise<ManagedAgentsRemoteSession> {
    const session = await this.#wrap(() =>
      this.#client.beta.sessions.retrieve(handle.id),
    );
    assertSessionOwnership(handle, session.metadata);
    return session;
  }

  async #serializeSync(
    flights: Map<string, Promise<void>>,
    localId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = flights.get(localId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    flights.set(localId, current);
    try {
      await current;
    } finally {
      if (flights.get(localId) === current) flights.delete(localId);
    }
  }

  async #wrap<T>(operation: () => Promise<T>, mapConflict = false): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isLocalError(error)) throw error;
      if (mapConflict && isRecord(error) && error.status === 409) {
        throw new ManagedAgentsConflictError(
          'Remote resource changed during synchronization',
        );
      }
      throw new ManagedAgentsProviderError(error);
    }
  }
}

export async function createManagedAgentsRuntimeProvider(
  options: ManagedAgentsRuntimeProviderOptions,
): Promise<ManagedAgentsProvider> {
  return createManagedAgentsRuntimeProviderWithDependencies(options, {});
}

export interface ManagedAgentsClientOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly timeout: number;
  readonly fetch?: typeof fetch;
}

export interface ManagedAgentsProviderDependencies {
  readonly client?: ManagedAgentsClient;
  readonly clientFactory?: (
    options: ManagedAgentsClientOptions,
  ) => ManagedAgentsClient | Promise<ManagedAgentsClient>;
  readonly clock?: Clock;
}

export async function createManagedAgentsRuntimeProviderWithDependencies(
  options: ManagedAgentsRuntimeProviderOptions,
  dependencies: ManagedAgentsProviderDependencies,
): Promise<ManagedAgentsProvider> {
  const validated = validateOptions(options);
  const client =
    dependencies.client ??
    (await (dependencies.clientFactory ?? defaultClientFactory)({
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      timeout: validated.requestTimeoutMs,
      ...(options.transport === undefined ? {} : { fetch: options.transport }),
    }));
  return new ManagedAgentsRuntimeProvider(
    client,
    dependencies.clock ?? systemClock,
    validated.limits,
    options.allowUnrestrictedNetworking === true,
    options.allowBuiltInWebEgress === true,
    options.ownershipSecret ?? options.apiKey,
  );
}

async function defaultClientFactory(
  options: ManagedAgentsClientOptions,
): Promise<ManagedAgentsClient> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    timeout: options.timeout,
    maxRetries: 0,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }) as unknown as ManagedAgentsClient;
}

const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (milliseconds) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
};

function validateOptions(options: ManagedAgentsRuntimeProviderOptions): {
  requestTimeoutMs: number;
  limits: RequiredLimits;
} {
  if (
    typeof options.apiKey !== 'string' ||
    options.apiKey.trim().length === 0
  ) {
    throw new ManagedAgentsConfigurationError('apiKey is required');
  }
  if (options.baseURL !== undefined) {
    try {
      const url = new URL(options.baseURL);
      if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username !== '' ||
        url.password !== ''
      ) {
        throw new Error('invalid');
      }
    } catch {
      throw new ManagedAgentsConfigurationError(
        'baseURL must be an HTTP(S) URL without credentials',
      );
    }
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 300_000
  ) {
    throw new ManagedAgentsConfigurationError(
      'requestTimeoutMs must be between 1 and 300000',
    );
  }
  return {
    requestTimeoutMs,
    limits: validateLimits(options.limits ?? {}),
  };
}

function validateLimits(limits: ManagedAgentsLimits): RequiredLimits {
  const result = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(result)) {
    if (
      !Number.isSafeInteger(value) ||
      value < (name.includes('Reconnects') ? 0 : 1)
    ) {
      throw new ManagedAgentsConfigurationError(
        `${name} must be a positive integer`,
      );
    }
  }
  return result;
}

function agentDefinition(agent: RuntimeAgent): Record<string, unknown> {
  const builtIns = agent.tools.filter((tool) => BUILT_IN_TOOLS.has(tool));
  const custom = agent.tools.filter((tool) => !BUILT_IN_TOOLS.has(tool));
  const mcpServers = agent.mcps.map((url, index) => ({
    type: 'url',
    name: `mcp-${index + 1}`,
    url,
  }));
  return {
    name: `agentos:${agent.id}`,
    model: agent.model,
    system: agent.instructions ?? null,
    tools: [
      ...(builtIns.length === 0
        ? []
        : [
            {
              type: 'agent_toolset_20260401',
              default_config: { enabled: false },
              configs: builtIns.map((name) => ({ name, enabled: true })),
            },
          ]),
      ...custom.map((name) => ({
        type: 'custom',
        name,
        description: `AgentOS custom tool ${name}`,
        input_schema: { type: 'object', additionalProperties: true },
      })),
      ...mcpServers.map((server) => ({
        type: 'mcp_toolset',
        mcp_server_name: server.name,
        default_config: {
          enabled: true,
          permission_policy: { type: 'always_allow' },
        },
      })),
    ],
    mcp_servers: mcpServers,
  };
}

function environmentDefinition(
  environment: ManagedAgentsRuntimeEnvironment,
): Record<string, unknown> {
  if (environment.runtime === 'self_hosted') return { type: 'self_hosted' };
  const networking = environment.networking ?? { type: 'limited' as const };
  return {
    type: 'cloud',
    networking:
      networking.type === 'unrestricted'
        ? { type: 'unrestricted' }
        : {
            type: 'limited',
            allowed_hosts: [...(networking.allowedHosts ?? [])],
            allow_mcp_servers: networking.allowMcpServers ?? false,
            allow_package_managers: networking.allowPackageManagers ?? false,
          },
    packages: Object.fromEntries(
      Object.entries(environment.packages ?? {}).map(([key, value]) => [
        key,
        [...value],
      ]),
    ),
  };
}

function metadataFor(localId: string, digest: string): Record<string, string> {
  return { [LOCAL_ID]: localId, [CONFIG_DIGEST]: digest, [OWNER_KEY]: OWNER };
}

function isUnrestricted(environment: ManagedAgentsRuntimeEnvironment): boolean {
  return (
    environment.runtime === 'cloud' &&
    environment.networking?.type === 'unrestricted'
  );
}

function findOwnedResource<
  T extends {
    name: string;
    metadata: Record<string, string>;
    archived_at: string | null;
  },
>(
  resources: readonly T[],
  localId: string,
  expectedName: string,
): T | undefined {
  const matches = resources.filter(
    (resource) =>
      resource.archived_at === null && resource.metadata[LOCAL_ID] === localId,
  );
  if (matches.length > 1) {
    throw new ManagedAgentsConflictError(
      'Duplicate remote resources for local ID',
    );
  }
  const nameCollisions = resources.filter(
    (resource) =>
      resource.archived_at === null &&
      resource.name === expectedName &&
      resource.metadata[LOCAL_ID] !== localId,
  );
  if (nameCollisions.length > 0) {
    throw new ManagedAgentsConflictError(
      'Remote resource name is already in use',
    );
  }
  return matches[0];
}

function assertOwnership(metadata: Record<string, string>): void {
  const owner = metadata[OWNER_KEY];
  if (owner !== OWNER) {
    throw new ManagedAgentsConflictError(
      'Remote resource has conflicting owner',
    );
  }
}

function assertSessionOwnership(
  handle: RuntimeHandle,
  metadata: Record<string, string>,
): asserts handle is ManagedAgentsRuntimeHandle {
  const candidate = handle as Partial<ManagedAgentsRuntimeHandle>;
  const suppliedHash = hashCapability(
    typeof candidate.ownershipCapability === 'string'
      ? candidate.ownershipCapability
      : '',
  );
  const storedHash = metadata[SESSION_CAPABILITY_HASH];
  const suppliedBytes = Buffer.from(
    suppliedHash.slice('sha256:'.length),
    'hex',
  );
  const storedBytes =
    typeof storedHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(storedHash)
      ? Buffer.from(storedHash.slice('sha256:'.length), 'hex')
      : Buffer.alloc(32);
  const capabilityMatches = timingSafeEqual(suppliedBytes, storedBytes);
  if (
    !capabilityMatches ||
    typeof candidate.runId !== 'string' ||
    typeof candidate.stepId !== 'string' ||
    metadata[RUN_ID] !== candidate.runId ||
    metadata[STEP_ID] !== candidate.stepId
  ) {
    throw new ManagedAgentsConflictError('Session ownership validation failed');
  }
}

function validateEnvironmentFields(
  environment: ManagedAgentsRuntimeEnvironment,
): void {
  if (
    environment.runtime !== 'cloud' &&
    environment.runtime !== 'self_hosted'
  ) {
    throw new ManagedAgentsConfigurationError(
      'environment.runtime must be cloud or self_hosted',
    );
  }
  if (environment.image !== undefined) {
    throw new ManagedAgentsConfigurationError(
      'environment.image is not supported by Managed Agents',
    );
  }
  if (Object.keys(environment.variables).length > 0) {
    throw new ManagedAgentsConfigurationError(
      'environment.variables are not supported; use provider vault credentials',
    );
  }
  if (
    environment.runtime === 'self_hosted' &&
    (environment.networking !== undefined || environment.packages !== undefined)
  ) {
    throw new ManagedAgentsConfigurationError(
      'self_hosted environments cannot declare cloud networking or packages',
    );
  }
}

async function collectBounded<T>(
  source: AsyncIterable<T>,
  limit: number,
): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) {
    if (result.length >= limit) {
      throw new ManagedAgentsLimitError(
        'Remote resource pagination limit exceeded',
      );
    }
    result.push(item);
  }
  return result;
}

function mapResource(
  resource: NonNullable<ManagedAgentsStartRequest['resources']>[number],
) {
  return {
    type: 'file',
    file_id: resource.fileId,
    ...(resource.mountPath === undefined
      ? {}
      : { mount_path: resource.mountPath }),
  };
}

function managedBudget(maxCostMicrodollars: number | undefined):
  | {
      readonly type: 'limit';
      readonly max_list_cost: {
        readonly amount: string;
        readonly currency: 'USD';
      };
    }
  | undefined {
  if (maxCostMicrodollars === undefined) return undefined;
  if (
    !Number.isSafeInteger(maxCostMicrodollars) ||
    maxCostMicrodollars < 10_000
  )
    throw new ManagedAgentsConfigurationError(
      'maxCostMicrodollars must fund at least one USD cent',
    );
  // Managed Agents budgets use integer minor currency units. Flooring keeps
  // the remote hard limit at or below the locally reserved amount.
  return {
    type: 'limit',
    max_list_cost: {
      amount: String(Math.floor(maxCostMicrodollars / 10_000)),
      currency: 'USD',
    },
  };
}

function isManagedHandle(
  handle: RuntimeHandle,
): handle is ManagedAgentsRuntimeHandle {
  return 'runId' in handle && 'stepId' in handle;
}

function validDeadline(value: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw new ManagedAgentsConfigurationError(
      'persisted session deadline is invalid',
    );
  return value;
}

function validEventTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error('trusted verification timestamp is malformed');
  return value;
}

function rawTextContent(value: unknown): string {
  if (!Array.isArray(value))
    throw new Error('trusted verification result is malformed');
  return value
    .map((block) => {
      if (
        !isRecord(block) ||
        block.type !== 'text' ||
        typeof block.text !== 'string'
      )
        throw new Error('trusted verification result is malformed');
      return block.text;
    })
    .join('');
}

function safeFilename(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(-96);
  if (sanitized.length === 0) return 'artifact.json';
  return sanitized;
}

function validatedMcpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ManagedAgentsConfigurationError('Artifact MCP URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  )
    throw new ManagedAgentsConfigurationError('Artifact MCP URL is invalid');
  return url.toString();
}

async function ignoreNotFound(
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isProviderNotFound(error)) throw error;
  }
}

function userMessage(text: string): Record<string, unknown> {
  return { type: 'user.message', content: [{ type: 'text', text }] };
}

function customToolResult(
  result: ManagedAgentsCustomToolResult,
  limit: number,
): Record<string, unknown> {
  const text = boundedText(result.content, limit, 'tool result');
  return {
    type: 'user.custom_tool_result',
    custom_tool_use_id: result.toolUseId,
    content: [{ type: 'text', text }],
    ...(result.isError === undefined ? {} : { is_error: result.isError }),
  };
}

function toolConfirmation(
  confirmation: ManagedAgentsToolConfirmation,
  limit: number,
): Record<string, unknown> {
  if (
    confirmation.result === 'allow' &&
    confirmation.denyMessage !== undefined
  ) {
    throw new ManagedAgentsConfigurationError(
      'denyMessage is only valid when denying a tool',
    );
  }
  return {
    type: 'user.tool_confirmation',
    tool_use_id: confirmation.toolUseId,
    result: confirmation.result,
    ...(confirmation.denyMessage === undefined
      ? {}
      : {
          deny_message: boundedText(
            confirmation.denyMessage,
            limit,
            'tool denial message',
          ),
        }),
  };
}

function boundedText(value: unknown, limit: number, label: string): string {
  const text =
    typeof value === 'string'
      ? value
      : JSON.stringify(value) === undefined
        ? 'null'
        : JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new ManagedAgentsLimitError(`${label} exceeds maxEventBytes`);
  }
  return text;
}

function isCustomToolResult(
  value: unknown,
): value is ManagedAgentsCustomToolResult {
  return (
    isRecord(value) &&
    value.type === 'custom_tool_result' &&
    typeof value.toolUseId === 'string'
  );
}

function isToolConfirmation(
  value: unknown,
): value is ManagedAgentsToolConfirmation {
  return (
    isRecord(value) &&
    value.type === 'tool_confirmation' &&
    typeof value.toolUseId === 'string' &&
    (value.result === 'allow' || value.result === 'deny')
  );
}

function parseStructuredOutput(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function configDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function hashCapability(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function validateLocalId(value: string, label: string): void {
  const hasControlCharacter = [...value].some(
    (character) => character.charCodeAt(0) <= 31,
  );
  if (value.length === 0 || value.length > 128 || hasControlCharacter) {
    throw new ManagedAgentsConfigurationError(`${label} is invalid`);
  }
}

function nonnegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function normalizeSessionStatus(
  value: unknown,
): ManagedAgentsRemoteSession['status'] {
  if (value === undefined || value === null || typeof value !== 'string') {
    throw new Error('Malformed provider status');
  }
  if (
    value === 'rescheduling' ||
    value === 'running' ||
    value === 'idle' ||
    value === 'terminated'
  ) {
    return value;
  }
  throw new Error('Unsupported provider status');
}

function normalizeOutputFile(
  file: {
    id: string;
    type: 'file';
    mime_type: string;
    size_bytes: number;
    scope?: { type: 'session'; id: string } | null;
  },
  sessionId: string,
) {
  if (
    typeof file.id !== 'string' ||
    file.id.length === 0 ||
    file.id.length > 256 ||
    typeof file.mime_type !== 'string' ||
    file.mime_type.length === 0 ||
    file.mime_type.length > 256 ||
    !Number.isSafeInteger(file.size_bytes) ||
    file.size_bytes < 0 ||
    file.scope?.type !== 'session' ||
    file.scope.id !== sessionId
  ) {
    throw new Error('Malformed provider file metadata');
  }
  return {
    key: file.id,
    mediaType: file.mime_type,
    sizeBytes: file.size_bytes,
  };
}

function isConflictResponse(error: unknown): boolean {
  return isRecord(error) && error.status === 409;
}

function isLocalError(error: unknown): boolean {
  return (
    error instanceof ManagedAgentsConfigurationError ||
    error instanceof ManagedAgentsConflictError ||
    error instanceof ManagedAgentsLimitError ||
    (error instanceof Error &&
      (error.message === 'Malformed provider event' ||
        error.message === 'Malformed provider file metadata' ||
        error.message === 'Unsupported provider event' ||
        error.message === 'Unsupported provider status'))
  );
}

function isProviderNotFound(error: unknown): boolean {
  return (
    error instanceof ManagedAgentsProviderError &&
    (error.status === 404 || error.code === 'not_found_error')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
