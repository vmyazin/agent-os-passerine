import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { authConfigFromEnv, readSession, SESSION_COOKIE } from './auth';

export async function requirePageSession(): Promise<{
  readonly login: string;
}> {
  const config = authConfigFromEnv(process.env);
  const store = await cookies();
  const session = readSession(config, store.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  return { login: session.login };
}
