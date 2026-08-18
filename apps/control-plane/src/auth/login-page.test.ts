import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginPage from '../../app/login/page';

describe('LoginPage', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENTOS_PUBLIC_URL', 'http://localhost:3000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders "Get In" CTA and secondary GitHub button on localhost', async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain('Get In');
    expect(markup).toContain('href="/auth/local"');
    expect(markup).toContain('Continue with GitHub');
    expect(markup).toContain('href="/auth/github"');
    expect(markup).toContain('Local development');
  });

  it('preserves returnTo in CTA URLs on localhost', async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ returnTo: '/runs?status=waiting' }),
    });
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain(
      'href="/auth/local?returnTo=%2Fruns%3Fstatus%3Dwaiting"',
    );
    expect(markup).toContain(
      'href="/auth/github?returnTo=%2Fruns%3Fstatus%3Dwaiting"',
    );
  });

  it('renders only GitHub sign-in button in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AGENTOS_PUBLIC_URL', 'https://control.example');

    const element = await LoginPage({
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(element);

    expect(markup).not.toContain('Get In');
    expect(markup).not.toContain('/auth/local');
    expect(markup).toContain('Continue with GitHub');
    expect(markup).toContain('Single operator');
  });

  it('displays error notice when error query param is present', async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ error: 'oauth' }),
    });
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain('GitHub sign-in could not be completed');
    expect(markup).toContain('role="alert"');
  });
});
