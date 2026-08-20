// src/auth/page-session.ts
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { authConfigFromEnv, readSession, SESSION_COOKIE } from './auth';

export async function readPageSession(): Promise<{
  readonly login: string;
} | null> {
  const config = authConfigFromEnv(process.env);
  const store = await cookies();
  const session = readSession(config, store.get(SESSION_COOKIE)?.value);
  return session ? { login: session.login } : null;
}

export async function requirePageSession(): Promise<{
  readonly login: string;
}> {
  const session = await readPageSession();
  if (!session) redirect('/login');
  return session;
}
