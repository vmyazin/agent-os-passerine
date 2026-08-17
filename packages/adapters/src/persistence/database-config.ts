export type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;

const INVALID_DATABASE_URL = 'DATABASE_URL must be a valid PostgreSQL URL';

export function databaseUrlFromEnv(environment: DatabaseEnvironment): string {
  const value = environment.DATABASE_URL;
  if (value === undefined || value.trim() === '') {
    throw new Error('DATABASE_URL is required');
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
      url.hostname === '' ||
      url.username === '' ||
      url.pathname.length <= 1
    ) {
      throw new Error(INVALID_DATABASE_URL);
    }
  } catch {
    throw new Error(INVALID_DATABASE_URL);
  }

  return value;
}
