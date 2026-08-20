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
  readonly allowBuiltInWebEgress?: boolean;
  readonly limits?: ManagedAgentsLimits;
  readonly transport?: typeof fetch;
  /** Stable secret used to derive restart-safe, non-exported session capabilities. */
  readonly ownershipSecret?: string;
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

export type ManagedAgentsSessionResource = ManagedAgentsFileResource;

export interface ManagedAgentsStartRequest extends RuntimeStartRequest {
  readonly roleId?: string;
  readonly resources?: readonly ManagedAgentsSessionResource[];
}

export interface ManagedAgentsAccessFile {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly mountPath: string;
}

export interface ManagedAgentsSessionAccess {
  readonly resources: readonly ManagedAgentsFileResource[];
  readonly credentialRefs: readonly string[];
}

export interface ManagedAgentsRuntimeHandle extends RuntimeHandle {
  readonly agentId: string;
  readonly agentVersion: number;
  readonly environmentId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly ownershipCapability: string;
  readonly deadlineAt?: string;
  readonly credentialRefs?: readonly string[];
  readonly uploadedFileIds?: readonly string[];
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
  forProject(projectId: string): ManagedAgentsProvider;
  provisionSessionAccess(input: {
    readonly idempotencyKey: string;
    readonly mcpUrl?: string;
    readonly bearerToken?: string;
    readonly files: readonly ManagedAgentsAccessFile[];
  }): Promise<ManagedAgentsSessionAccess>;
  start(
    request: ManagedAgentsStartRequest,
  ): Promise<ManagedAgentsRuntimeHandle>;
  reconcileStart(
    request: ManagedAgentsStartRequest,
  ): Promise<ManagedAgentsRuntimeHandle | undefined>;
  syncEnvironment(environment: ManagedAgentsRuntimeEnvironment): Promise<void>;
  listEvents(handle: RuntimeHandle): Promise<readonly RuntimeEvent[]>;
  status(handle: RuntimeHandle): Promise<ManagedAgentsStatus>;
  observeCommand(
    handle: RuntimeHandle,
    expectedCommand: string,
  ): Promise<import('@agentos/core').RuntimeObservedCommand>;
}
