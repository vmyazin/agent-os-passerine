import type {
  AttestationVerifier,
  PublicationAuthorizationClaims,
  PublicationManifestBody,
} from '@agentos/core';

import { createGitHubAppClientFactory } from './github-app.js';
import { createNeonPublicationStore } from './postgres-store.js';
import { createTrustedGitHubPublisher } from './publisher.js';
import type {
  PublicationResult,
  PublicationStatusResult,
} from './public-types.js';

export interface TrustedPublicationPolicyResolver {
  resolve(input: {
    readonly projectId: string;
    readonly runId: string;
    readonly configDigest: string;
    readonly policyDigest: string;
  }): Promise<unknown>;
}

export interface TrustedGitHubPublisherServiceOptions {
  readonly githubApp: {
    readonly appId: number;
    readonly privateKey: string;
  };
  readonly databaseEnvironment: Readonly<Record<string, string | undefined>>;
  readonly authorizationVerifier: AttestationVerifier<PublicationAuthorizationClaims>;
  readonly selectedRepositories: readonly PublicationManifestBody['repository'][];
  readonly policyResolver: TrustedPublicationPolicyResolver;
  readonly isCancelled?: (projectId: string, runId: string) => Promise<boolean>;
}

export interface TrustedGitHubPublisherService {
  publish(input: unknown): Promise<PublicationResult>;
  cancel(input: unknown): Promise<PublicationStatusResult>;
  status(input: unknown): Promise<PublicationStatusResult>;
}

export function createTrustedGitHubPublisherService(
  options: TrustedGitHubPublisherServiceOptions,
): TrustedGitHubPublisherService {
  const publisher = createTrustedGitHubPublisher({
    clients: createGitHubAppClientFactory(options.githubApp),
    store: createNeonPublicationStore(options.databaseEnvironment),
    authorizationVerifier: options.authorizationVerifier,
    selectedRepositories: options.selectedRepositories,
    policyResolver: (input) => options.policyResolver.resolve(input),
    ...(options.isCancelled === undefined
      ? {}
      : { isCancelled: options.isCancelled }),
  });
  return Object.freeze({
    publish: publisher.publish,
    cancel: publisher.cancel,
    status: publisher.status,
  });
}
