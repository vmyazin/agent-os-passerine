import type { SignedAttestation } from './attestation.js';
export type { ArtifactAdminStore, ArtifactStore } from './artifacts.js';

export type Identifier = string;

export interface RuntimeAgent {
  readonly id: Identifier;
  readonly model: string;
  readonly instructions?: string;
  readonly tools: readonly string[];
  readonly mcps: readonly string[];
}

export interface RuntimeEnvironment {
  readonly id: Identifier;
  readonly runtime: string;
  readonly image?: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly networking?:
    | {
        readonly type: 'limited';
        readonly allowedHosts?: readonly string[];
        readonly allowMcpServers?: boolean;
        readonly allowPackageManagers?: boolean;
      }
    | { readonly type: 'unrestricted' };
  readonly packages?: Readonly<{
    apt?: readonly string[];
    cargo?: readonly string[];
    gem?: readonly string[];
    go?: readonly string[];
    npm?: readonly string[];
    pip?: readonly string[];
  }>;
}

export interface RuntimeFileResource {
  readonly type: 'file';
  readonly fileId: string;
  readonly mountPath?: string;
}

export interface RuntimeHandle {
  readonly id: Identifier;
}

export interface RuntimeStartRequest {
  readonly runId: Identifier;
  readonly stepId: Identifier;
  readonly agentId: Identifier;
  readonly environmentId: Identifier;
  readonly input: unknown;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
  readonly maxCostMicrodollars?: number;
  readonly resources?: readonly RuntimeFileResource[];
  /** Opaque provider credential references; never raw credentials. */
  readonly credentialRefs?: readonly string[];
}

/** Provider-neutral event vocabulary accepted by durable workflows. */
export const RUNTIME_EVENT_TYPES = [
  'message',
  'progress',
  'message_summary',
  'tool_call',
  'tool_result',
  'running',
  'rescheduling',
  'terminated',
  'idle',
  'error',
  'usage',
  'thread_created',
  'thread_running',
  'thread_idle',
  'thread_rescheduling',
  'thread_terminated',
  'thread_message',
  'input_acknowledged',
  'session_updated',
  'deleted',
  'requires_action',
  'retries_exhausted',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export function isRuntimeEventType(value: string): value is RuntimeEventType {
  return (RUNTIME_EVENT_TYPES as readonly string[]).includes(value);
}

export interface RuntimeEvent {
  readonly id: Identifier;
  readonly type: RuntimeEventType;
  readonly occurredAt: Date;
  readonly payload?: unknown;
}

export interface RuntimeOutput {
  readonly text?: string;
  readonly artifacts: readonly RuntimeArtifactReference[];
  readonly data?: unknown;
}

export interface RuntimeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly runtimeMs: number;
}

export interface RuntimeObservedCommand {
  readonly command: string;
  readonly exitCode: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface RuntimeProvider {
  syncAgent(agent: RuntimeAgent): Promise<void>;
  syncEnvironment(environment: RuntimeEnvironment): Promise<void>;
  start(request: RuntimeStartRequest): Promise<RuntimeHandle>;
  reconcileStart?(
    request: RuntimeStartRequest,
  ): Promise<RuntimeHandle | undefined>;
  events(handle: RuntimeHandle): AsyncIterable<RuntimeEvent>;
  send(handle: RuntimeHandle, message: unknown): Promise<void>;
  resume(handle: RuntimeHandle, input?: unknown): Promise<void>;
  cancel(handle: RuntimeHandle, reason?: string): Promise<void>;
  collectOutput(handle: RuntimeHandle): Promise<RuntimeOutput>;
  usage(handle: RuntimeHandle): Promise<RuntimeUsage>;
  cleanup(handle: RuntimeHandle): Promise<void>;
  observeCommand?(
    handle: RuntimeHandle,
    expectedCommand: string,
  ): Promise<RuntimeObservedCommand>;
}

export interface RuntimeArtifactReference {
  readonly key: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly hash?: string;
}

export interface RepositoryValidationRequest {
  readonly repository: string;
  readonly baseSha: string;
  readonly headSha?: string;
}

export interface RepositoryValidationResult {
  readonly valid: boolean;
  readonly messages: readonly string[];
}

export interface DraftPublicationRequest {
  readonly repository: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
}

export interface DraftPublication {
  readonly id: string;
  readonly url: string;
  readonly draft: true;
  readonly attestation: SignedAttestation<RepositoryPublisherAttestationClaims>;
}

export interface RepositoryPublisherAttestationClaims {
  readonly source: 'repository-publisher';
  readonly scopeHash: string;
  readonly actionHash: string;
  readonly baseSha: string;
  readonly patchHash: string;
}

export type RepositoryPublisherAttestation =
  SignedAttestation<RepositoryPublisherAttestationClaims>;

export interface RepositoryPublisher {
  validate(
    request: RepositoryValidationRequest,
  ): Promise<RepositoryValidationResult>;
  publishDraft(request: DraftPublicationRequest): Promise<DraftPublication>;
}

export interface UsageRecord extends RuntimeUsage {
  readonly runId: string;
  readonly stepId: string;
  readonly model: string;
  readonly microdollars: number;
  readonly recordedAt: Date;
}

export interface UsageMeter {
  record(usage: UsageRecord): Promise<void>;
  list(runId: string): Promise<readonly UsageRecord[]>;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}
