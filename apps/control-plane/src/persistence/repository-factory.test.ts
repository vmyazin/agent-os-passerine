import { describe, expect, it } from 'vitest';

import { createRepository } from './repository-factory';

describe('repository factory', () => {
  it('requires Neon in production and explicit memory configuration in tests', () => {
    expect(() => createRepository({ NODE_ENV: 'production' })).toThrow(
      'DATABASE_URL is required',
    );
    expect(() => createRepository({ NODE_ENV: 'test' })).toThrow(
      'AGENTOS_REPOSITORY must be explicitly configured',
    );
    expect(
      createRepository({ NODE_ENV: 'test', AGENTOS_REPOSITORY: 'memory' }),
    ).toBeDefined();
  });
});
