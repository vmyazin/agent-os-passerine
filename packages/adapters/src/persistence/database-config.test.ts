import { describe, expect, it } from 'vitest';

import { databaseUrlFromEnv } from './database-config.js';

describe('databaseUrlFromEnv', () => {
  it('fails closed when DATABASE_URL is absent', () => {
    expect(() => databaseUrlFromEnv({})).toThrow('DATABASE_URL is required');
  });

  it.each([
    'not-a-url',
    'https://example.com/database',
    'postgresql://localhost',
    'postgresql://user@/database',
  ])(
    'rejects malformed or non-PostgreSQL URLs without exposing them',
    (url) => {
      expect(() => databaseUrlFromEnv({ DATABASE_URL: url })).toThrow(
        'DATABASE_URL must be a valid PostgreSQL URL',
      );
    },
  );

  it('accepts Neon-compatible PostgreSQL URLs', () => {
    expect(
      databaseUrlFromEnv({
        DATABASE_URL:
          'postgresql://user:secret@example.neon.tech/agentos?sslmode=require',
      }),
    ).toBe(
      'postgresql://user:secret@example.neon.tech/agentos?sslmode=require',
    );
  });
});
