import type { OpaqueAttestation } from './attestation.js';

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
}

export interface RuntimeEvent {
  readonly id: Identifier;
  readonly type: string;
  readonly occurredAt: Date;
  readonly payload?: unknown;
}

export interface RuntimeOutput {
  readonly text?: string;
  readonly artifacts: readonly ArtifactReference[];
  readonly data?: unknown;
}

export interface RuntimeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runtimeMs: number;
}

export interface RuntimeProvider {
  syncAgent(agent: RuntimeAgent): Promise<void>;
  syncEnvironment(environment: RuntimeEnvironment): Promise<void>;
  start(request: RuntimeStartRequest): Promise<RuntimeHandle>;
  events(handle: RuntimeHandle): AsyncIterable<RuntimeEvent>;
  send(handle: RuntimeHandle, message: unknown): Promise<void>;
  resume(handle: RuntimeHandle, input?: unknown): Promise<void>;
  cancel(handle: RuntimeHandle, reason?: string): Promise<void>;
  collectOutput(handle: RuntimeHandle): Promise<RuntimeOutput>;
  usage(handle: RuntimeHandle): Promise<RuntimeUsage>;
  cleanup(handle: RuntimeHandle): Promise<void>;
}

export interface ArtifactReference {
  readonly key: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly hash?: string;
}

export interface ArtifactValue extends ArtifactReference {
  readonly bytes: Uint8Array;
}

export interface ArtifactPutRequest {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export interface ArtifactStore {
  get(key: string): Promise<ArtifactValue | undefined>;
  put(request: ArtifactPutRequest): Promise<ArtifactReference>;
  list(prefix?: string): Promise<readonly ArtifactReference[]>;
}

export interface ArtifactAdminStore {
  delete(key: string): Promise<boolean>;
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
  readonly attestation: OpaqueAttestation<RepositoryPublisherAttestationClaims>;
}

export interface RepositoryPublisherAttestationClaims {
  readonly source: 'repository-publisher';
  readonly scopeHash: string;
  readonly actionHash: string;
  readonly baseSha: string;
  readonly patchHash: string;
}

export type RepositoryPublisherAttestation =
  OpaqueAttestation<RepositoryPublisherAttestationClaims>;

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
