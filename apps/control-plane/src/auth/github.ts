import type { AuthConfig } from './auth';
import { AuthError } from './auth';

export async function exchangeGitHubCode(
  config: AuthConfig,
  code: string,
  verifier: string,
): Promise<{ readonly login: string }> {
  const tokenResponse = await fetch(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: `${config.publicUrl}/auth/github/callback`,
      }),
      cache: 'no-store',
    },
  );
  const token = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenResponse.ok || !token.access_token || token.error) {
    throw new AuthError(
      'oauth_exchange_failed',
      'GitHub token exchange failed',
    );
  }
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token.access_token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });
  const user = (await userResponse.json()) as { login?: string };
  if (!userResponse.ok || !user.login) {
    throw new AuthError(
      'oauth_identity_failed',
      'GitHub identity lookup failed',
    );
  }
  return { login: user.login };
}
