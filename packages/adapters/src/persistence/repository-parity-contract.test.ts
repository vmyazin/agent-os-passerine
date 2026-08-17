import { InMemoryDomainRepository } from './in-memory.js';
import { repositoryParityContract } from './repository-parity-contract.js';

repositoryParityContract('in-memory', () => new InMemoryDomainRepository());
