import type {
  RuntimeEnvironment,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeStartRequest,
} from '@agentos/core';

export interface ManagedAgentsLimits {
  readonly maxRemoteResources?: number;
  readonly maxListedEvents?: number;
  readonly maxEventBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxStreamDurationMs?: number;
  readonly maxStreamReconnects?: number;
  readonly streamReconnectDelayMs?: number;
}

export interface ManagedAgentsRuntimeProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly requestTimeoutMs?: number;
  readonly allowUnrestrictedNetworking?: boolean;
  readonly limits?: ManagedAgentsLimits;
  readonly transport?: typeof fetch;
}

export interface ManagedAgentsLimitedNetworking {
  readonly type: 'limited';
  readonly allowedHosts?: readonly string[];
  readonly allowMcpServers?: boolean;
  readonly allowPackageManagers?: boolean;
}

export interface ManagedAgentsUnrestrictedNetworking {
  readonly type: 'unrestricted';
}

export interface ManagedAgentsRuntimeEnvironment extends RuntimeEnvironment {
  readonly networking?:
    ManagedAgentsLimitedNetworking | ManagedAgentsUnrestrictedNetworking;
  readonly packages?: Readonly<{
    apt?: readonly string[];
    cargo?: readonly string[];
    gem?: readonly string[];
    go?: readonly string[];
    npm?: readonly string[];
    pip?: readonly string[];
  }>;
}

export interface ManagedAgentsFileResource {
  readonly type: 'file';
  readonly fileId: string;
  readonly mountPath?: string;
}

export interface ManagedAgentsSourceSnapshotResource {
  readonly type: 'source_snapshot';
  readonly repositoryUrl: string;
  readonly commitSha: string;
  readonly authorizationToken: string;
  readonly mountPath?: string;
}

export type ManagedAgentsSessionResource =
  ManagedAgentsFileResource | ManagedAgentsSourceSnapshotResource;

export interface ManagedAgentsStartRequest extends RuntimeStartRequest {
  readonly roleId?: string;
  readonly resources?: readonly ManagedAgentsSessionResource[];
}

export interface ManagedAgentsRuntimeHandle extends RuntimeHandle {
  readonly agentId: string;
  readonly agentVersion: number;
  readonly environmentId: string;
}

export interface ManagedAgentsCustomToolResult {
  readonly type: 'custom_tool_result';
  readonly toolUseId: string;
  readonly content?: unknown;
  readonly isError?: boolean;
}

export interface ManagedAgentsToolConfirmation {
  readonly type: 'tool_confirmation';
  readonly toolUseId: string;
  readonly result: 'allow' | 'deny';
  readonly denyMessage?: string;
}

export type ManagedAgentsNormalizedStatus =
  | 'rescheduling'
  | 'running'
  | 'idle'
  | 'requires_action'
  | 'retries_exhausted'
  | 'terminated';

export interface ManagedAgentsStatus {
  readonly status: 'rescheduling' | 'running' | 'idle' | 'terminated';
}

export interface ManagedAgentsProvider extends RuntimeProvider {
  start(
    request: ManagedAgentsStartRequest,
  ): Promise<ManagedAgentsRuntimeHandle>;
  syncEnvironment(environment: ManagedAgentsRuntimeEnvironment): Promise<void>;
  listEvents(handle: RuntimeHandle): Promise<readonly RuntimeEvent[]>;
  status(handle: RuntimeHandle): Promise<ManagedAgentsStatus>;
}
