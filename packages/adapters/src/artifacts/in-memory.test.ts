import { artifactStoreContract } from './artifact-store-contract.js';
import { createInMemoryArtifactStorage } from './in-memory.js';

artifactStoreContract('in-memory', () =>
  createInMemoryArtifactStorage({
    now: () => new Date('2026-08-17T00:00:00.000Z'),
  }),
);
