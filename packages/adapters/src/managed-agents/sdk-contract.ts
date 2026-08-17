/**
 * Narrow structural facade over @anthropic-ai/sdk 0.117.1.
 *
 * Managed Agents is beta. Keeping its generated types out of public signatures
 * prevents an SDK beta rename from leaking through @agentos/adapters.
 */
export interface ManagedAgentsRemoteAgent {
  id: string;
  type: 'agent';
  name: string;
  model: { id: string };
  system: string | null;
  tools: readonly unknown[];
  mcp_servers: readonly unknown[];
  metadata: Record<string, string>;
  version: number;
  archived_at: string | null;
}

export interface ManagedAgentsRemoteEnvironment {
  id: string;
  type: 'environment';
  name: string;
  description: string;
  metadata: Record<string, string>;
  config: {
    type: 'cloud' | 'self_hosted';
    networking?: { type: 'limited' | 'unrestricted'; [key: string]: unknown };
    [key: string]: unknown;
  };
  archived_at: string | null;
}

export interface ManagedAgentsRemoteSession {
  id: string;
  type: 'session';
  agent: { id: string; version: number };
  environment_id: string;
  metadata: Record<string, string>;
  status: 'rescheduling' | 'running' | 'idle' | 'terminated';
  resources: Array<{ id: string; type: string; [key: string]: unknown }>;
  vault_ids?: string[];
  archived_at: string | null;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    };
    active_seconds?: number;
    [key: string]: unknown;
  };
  stats: { active_seconds?: number; [key: string]: unknown };
}

export interface ManagedAgentsEvent {
  id?: string;
  type?: string;
  processed_at?: string | null;
  [key: string]: unknown;
}

export interface ManagedAgentsRemoteFile {
  id: string;
  type: 'file';
  filename: string;
  mime_type: string;
  size_bytes: number;
  downloadable?: boolean;
  scope?: { type: 'session'; id: string } | null;
}

export interface ManagedAgentsRemoteVault {
  id: string;
  type: 'vault';
  metadata: Record<string, string>;
  archived_at: string | null;
}

interface ManagedAgentsAgentsResource {
  list(params?: unknown): Promise<AsyncIterable<ManagedAgentsRemoteAgent>>;
  create(params: unknown): Promise<ManagedAgentsRemoteAgent>;
  update(id: string, params: unknown): Promise<ManagedAgentsRemoteAgent>;
}

interface ManagedAgentsEnvironmentsResource {
  list(
    params?: unknown,
  ): Promise<AsyncIterable<ManagedAgentsRemoteEnvironment>>;
  create(params: unknown): Promise<ManagedAgentsRemoteEnvironment>;
  update(id: string, params: unknown): Promise<ManagedAgentsRemoteEnvironment>;
}

interface ManagedAgentsSessionsResource {
  list?(params?: unknown): Promise<AsyncIterable<ManagedAgentsRemoteSession>>;
  create(params: unknown): Promise<ManagedAgentsRemoteSession>;
  retrieve(id: string): Promise<ManagedAgentsRemoteSession>;
  archive(id: string): Promise<ManagedAgentsRemoteSession>;
  delete(id: string): Promise<{ id: string; type: 'session_deleted' }>;
  events: {
    list(
      id: string,
      params?: unknown,
    ): Promise<AsyncIterable<ManagedAgentsEvent>>;
    stream(
      id: string,
      params?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<ManagedAgentsEvent>>;
    send(id: string, params: unknown): Promise<unknown>;
  };
}

export interface ManagedAgentsClient {
  readonly beta: {
    readonly agents: ManagedAgentsAgentsResource;
    readonly environments: ManagedAgentsEnvironmentsResource;
    readonly sessions: ManagedAgentsSessionsResource;
    readonly files: {
      list(params: {
        scope_id?: string;
        betas: readonly ['managed-agents-2026-04-01'];
      }): Promise<AsyncIterable<ManagedAgentsRemoteFile>>;
      upload(params: {
        file: unknown;
        betas: readonly ['managed-agents-2026-04-01'];
      }): Promise<ManagedAgentsRemoteFile>;
      delete(
        id: string,
        params: {
          betas: readonly ['managed-agents-2026-04-01'];
        },
      ): Promise<unknown>;
    };
    readonly vaults: {
      list(params: {
        include_archived: boolean;
        betas: readonly ['managed-agents-2026-04-01'];
      }): Promise<AsyncIterable<ManagedAgentsRemoteVault>>;
      create(params: {
        display_name: string;
        metadata?: Record<string, string>;
        betas: readonly ['managed-agents-2026-04-01'];
      }): Promise<ManagedAgentsRemoteVault>;
      archive(
        id: string,
        params: {
          betas: readonly ['managed-agents-2026-04-01'];
        },
      ): Promise<ManagedAgentsRemoteVault>;
      delete(
        id: string,
        params: {
          betas: readonly ['managed-agents-2026-04-01'];
        },
      ): Promise<unknown>;
      credentials: {
        list(
          vaultId: string,
          params: {
            include_archived: boolean;
            betas: readonly ['managed-agents-2026-04-01'];
          },
        ): Promise<
          AsyncIterable<{
            id: string;
            metadata: Record<string, string>;
            archived_at: string | null;
          }>
        >;
        create(
          vaultId: string,
          params: {
            auth: {
              type: 'static_bearer';
              token: string;
              mcp_server_url: string;
            };
            display_name: string;
            metadata?: Record<string, string>;
            betas: readonly ['managed-agents-2026-04-01'];
          },
        ): Promise<unknown>;
      };
    };
  };
}
