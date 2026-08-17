import {
  createNeonDomainRepository,
  InMemoryDomainRepository,
} from '@agentos/adapters';
import type { DomainRepository } from '@agentos/core';

export type RepositoryEnvironment = Partial<Record<string, string | undefined>>;

export function createRepository(
  environment: RepositoryEnvironment,
): DomainRepository {
  const mode = environment.AGENTOS_REPOSITORY?.trim();
  const nodeEnv = environment.NODE_ENV ?? 'development';
  if (mode === 'memory') {
    if (nodeEnv === 'production') {
      throw new Error('memory repository is disabled in production');
    }
    return new InMemoryDomainRepository();
  }
  if (!mode && nodeEnv !== 'production') {
    throw new Error('AGENTOS_REPOSITORY must be explicitly configured');
  }
  if (mode && mode !== 'neon')
    throw new Error('unsupported AGENTOS_REPOSITORY');
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return createNeonDomainRepository(databaseUrl);
}

const repositoryState = globalThis as typeof globalThis & {
  __agentosRepository?: DomainRepository;
};

export function repositoryFromEnv(): DomainRepository {
  repositoryState.__agentosRepository ??= createRepository(process.env);
  return repositoryState.__agentosRepository;
}

export function resetRepositoryForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('repository reset is test-only');
  }
  delete repositoryState.__agentosRepository;
}
