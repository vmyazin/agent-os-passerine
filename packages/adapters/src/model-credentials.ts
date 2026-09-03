import {
  openSecret,
  secretKeyFromBase64Url,
  type DomainRepository,
  type ModelProvider,
} from '@agentos/core';

/** Where the environment carries the key that seals stored credentials. */
export const SECRET_KEY_VARIABLE = 'AGENTOS_SECRET_KEY';

/** Binds a sealed credential to the provider it belongs to. */
export function providerCredentialPurpose(providerId: string): string {
  return `provider-credential:${providerId}`;
}

export class ModelCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCredentialError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The key that opens stored credentials, or nothing.
 *
 * Absent is a supported state: a deployment that keeps its provider keys in
 * the environment needs no sealing key at all. It only becomes required once
 * a credential is stored, and then the failure says so.
 */
export function secretKeyFromEnv(
  environment: Environment,
): Uint8Array | undefined {
  const value = environment[SECRET_KEY_VARIABLE]?.trim();
  return value ? secretKeyFromBase64Url(value) : undefined;
}

export interface ResolvedModelCredential {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Which of the two places the key came from, for the operator's benefit. */
  readonly source: 'database' | 'environment';
}

/**
 * Reads a provider's API key at the moment it is needed.
 *
 * A stored credential wins over the environment: it is the one an operator
 * set deliberately and most recently, and a stale variable in a shell should
 * not quietly override what the UI says is in use.
 *
 * Nothing is cached. The composition is built once per process, so a cached
 * credential would mean a key added or rotated in the UI did not take effect
 * until a restart -- which is exactly the friction that storing keys was
 * meant to remove.
 */
export function createModelCredentialResolver(options: {
  readonly repository: Pick<DomainRepository, 'getProviderCredential'>;
  readonly environment: Environment;
}) {
  const { repository, environment } = options;
  return async function resolve(
    provider: ModelProvider,
  ): Promise<ResolvedModelCredential | undefined> {
    const baseUrl =
      environment[provider.baseUrlEnv]?.trim() || provider.defaultBaseUrl;
    const stored = await repository.getProviderCredential(provider.id);
    if (stored !== undefined) {
      const key = secretKeyFromEnv(environment);
      if (key === undefined)
        throw new ModelCredentialError(
          `${provider.label} has a stored API key but ${SECRET_KEY_VARIABLE} is not set, so it cannot be read`,
        );
      return {
        apiKey: openSecret(
          key,
          stored.sealedApiKey,
          providerCredentialPurpose(provider.id),
        ),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        source: 'database',
      };
    }
    const fromEnvironment = environment[provider.apiKeyEnv]?.trim();
    return fromEnvironment
      ? {
          apiKey: fromEnvironment,
          ...(baseUrl === undefined ? {} : { baseUrl }),
          source: 'environment',
        }
      : undefined;
  };
}
