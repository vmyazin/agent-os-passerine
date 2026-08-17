import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/adapters/src/persistence/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  ...(databaseUrl === undefined ? {} : { dbCredentials: { url: databaseUrl } }),
});
