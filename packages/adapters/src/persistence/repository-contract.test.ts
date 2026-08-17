import { InMemoryDomainRepository } from './in-memory.js';
import { NeonDomainRepository } from './neon-repository.js';
import { domainRepositoryContract } from './repository-contract.js';
import { stepRuns } from './schema.js';

function fakeNeonRepository(): NeonDomainRepository {
  const storedSteps = new Map<string, Readonly<Record<string, unknown>>>();
  const database = {
    insert(table: unknown) {
      let value: Readonly<Record<string, unknown>> = {};
      let conflictSet: Readonly<Record<string, unknown>> | undefined;
      const builder = {
        values(next: Readonly<Record<string, unknown>>) {
          value = next;
          return builder;
        },
        onConflictDoUpdate(config: {
          readonly set: Readonly<Record<string, unknown>>;
        }) {
          conflictSet = config.set;
          return builder;
        },
        returning() {
          if (table !== stepRuns) return [value];

          const key = `${String(value.runId)}:${String(value.stepKey)}:${String(value.attempt)}`;
          const existing = storedSteps.get(key);
          const stored =
            existing === undefined
              ? value
              : { ...existing, ...(conflictSet ?? {}) };
          storedSteps.set(key, stored);
          return [stored];
        },
      };
      return builder;
    },
  };

  return new NeonDomainRepository(database as never);
}

domainRepositoryContract('in-memory', () => new InMemoryDomainRepository());
domainRepositoryContract('neon', fakeNeonRepository);
