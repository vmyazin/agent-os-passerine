import type { GitHubPublicationRepository } from '@agentos/core';
import type { PublicationPhase } from './public-types.js';

export type {
  PublicationPhase,
  PublicationResult,
  PublicationStatusResult,
} from './public-types.js';

export interface GitRepository {
  readonly id: number;
  readonly fullName: string;
  readonly defaultBranch: string;
}

export interface GitTreeEntry {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000' | '160000' | '040000';
  readonly type: 'blob' | 'tree' | 'commit';
  readonly sha: string;
}

export interface GitHubInstallationClient {
  getRepository(): Promise<GitRepository>;
  getReference(branch: string): Promise<{ readonly sha: string } | undefined>;
  getCommit(sha: string): Promise<{
    readonly sha: string;
    readonly treeSha: string;
    readonly parents: readonly string[];
    readonly message: string;
  }>;
  getTree(sha: string): Promise<{
    readonly sha: string;
    readonly truncated: boolean;
    readonly entries: readonly GitTreeEntry[];
  }>;
  getBlob(sha: string): Promise<{
    readonly sha: string;
    readonly size: number;
    readonly bytes: Uint8Array;
  }>;
  createBlob(input: {
    readonly content: string;
    readonly encoding: 'utf-8';
  }): Promise<{ readonly sha: string }>;
  createTree(input: {
    readonly baseTree: string;
    readonly entries: readonly {
      readonly path: string;
      readonly mode: '100644' | '100755';
      readonly type: 'blob';
      readonly sha: string | null;
    }[];
  }): Promise<{ readonly sha: string }>;
  createCommit(input: {
    readonly message: string;
    readonly tree: string;
    readonly parents: readonly string[];
    readonly author: GitIdentity;
    readonly committer: GitIdentity;
  }): Promise<{ readonly sha: string }>;
  createReference(input: {
    readonly ref: string;
    readonly sha: string;
  }): Promise<{ readonly ref: string; readonly sha: string }>;
  listOpenPullRequests(input: {
    readonly head: string;
    readonly base: string;
  }): Promise<readonly PullRequest[]>;
  createDraftPullRequest(input: {
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
    readonly draft: true;
  }): Promise<PullRequest>;
}

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
  readonly date: string;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly draft: boolean;
  readonly state: 'open' | 'closed';
  readonly title: string;
  readonly head: string;
  readonly headSha: string;
  readonly base: string;
  readonly baseSha: string;
  readonly headRepositoryId: number;
  readonly baseRepositoryId: number;
  readonly body: string;
}

export type InstallationClientScope = GitHubPublicationRepository & {
  readonly repositoryIds: readonly [number];
  readonly permissions: {
    readonly contents: 'write';
    readonly pullRequests: 'write';
  };
};

export type ReadOnlyInstallationClientScope = GitHubPublicationRepository & {
  readonly repositoryIds: readonly [number];
  readonly permissions: { readonly contents: 'read' };
};

export interface GitHubInstallationClientFactory {
  withClient<T>(
    scope: InstallationClientScope,
    operation: (client: GitHubInstallationClient) => Promise<T>,
  ): Promise<T>;
}

export interface GitHubReadOnlyClientFactory {
  withClient<T>(
    scope: ReadOnlyInstallationClientScope,
    operation: (client: GitHubReadOnlyInstallationClient) => Promise<T>,
  ): Promise<T>;
}

export type GitHubReadOnlyInstallationClient = Pick<
  GitHubInstallationClient,
  'getRepository' | 'getReference' | 'getCommit' | 'getTree' | 'getBlob'
>;

export interface PublicationRecord {
  readonly key: string;
  readonly bindingKey: string;
  readonly projectId: string;
  readonly runId: string;
  readonly repositoryId: number;
  readonly manifestDigest: string;
  readonly policyDigest: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly phase: PublicationPhase;
  readonly blobShas?: Readonly<Record<string, string>>;
  readonly treeSha?: string;
  readonly commitSha?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
  readonly draft?: true;
  readonly errorCode?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicationEvent {
  readonly publicationKey: string;
  readonly phase: PublicationPhase;
  readonly at: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface PublicationStore {
  claim(
    input: Omit<
      PublicationRecord,
      'phase' | 'revision' | 'createdAt' | 'updatedAt'
    > & {
      readonly now: string;
    },
  ): Promise<PublicationRecord>;
  save(
    key: string,
    expectedRevision: number,
    patch: Partial<
      Omit<
        PublicationRecord,
        | 'key'
        | 'bindingKey'
        | 'projectId'
        | 'runId'
        | 'repositoryId'
        | 'manifestDigest'
        | 'policyDigest'
        | 'baseSha'
        | 'branch'
        | 'revision'
        | 'createdAt'
      >
    > & {
      readonly phase: PublicationPhase;
      readonly updatedAt: string;
    },
    event: PublicationEvent,
  ): Promise<PublicationRecord>;
  get(key: string): Promise<PublicationRecord | undefined>;
  listEvents(): Promise<readonly PublicationEvent[]>;
}
