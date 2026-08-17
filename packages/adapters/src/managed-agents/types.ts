import type {
  Clock,
  RuntimeEnvironment,
  RuntimeHandle,
  RuntimeStartRequest,
} from '@agentos/core';

import type { ManagedAgentsClient } from './sdk-contract.js';

export interface ManagedAgentsLimits {
  readonly maxRemoteResources?: number;
  readonly maxListedEvents?: number;
  readonly maxEventBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxStreamDurationMs?: number;
  readonly maxStreamReconnects?: number;
  readonly streamReconnectDelayMs?: number;
}

export interface ManagedAgentsClientOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly timeout: number;
  readonly fetch?: typeof fetch;
}

export interface ManagedAgentsRuntimeProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly requestTimeoutMs?: number;
  readonly allowUnrestrictedNetworking?: boolean;
  readonly limits?: ManagedAgentsLimits;
  readonly client?: ManagedAgentsClient;
  readonly clientFactory?: (
    options: ManagedAgentsClientOptions,
  ) => ManagedAgentsClient | Promise<ManagedAgentsClient>;
  readonly transport?: typeof fetch;
  readonly clock?: Clock;
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
