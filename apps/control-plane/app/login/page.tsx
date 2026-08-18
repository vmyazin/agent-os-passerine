import { createElement } from 'react';

import {
  isLocalhostBypassAllowed,
  sanitizeReturnTo,
} from '../../src/auth/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const { error, returnTo } = await searchParams;
  const isLocal = isLocalhostBypassAllowed(process.env);
  const safeReturn = sanitizeReturnTo(returnTo);
  const querySuffix =
    safeReturn !== '/' ? `?returnTo=${encodeURIComponent(safeReturn)}` : '';
  const localAuthUrl = `/auth/local${querySuffix}`;
  const githubAuthUrl = `/auth/github${querySuffix}`;

  return createElement(
    'section',
    { 'aria-labelledby': 'login-title', className: 'auth-card' },
    createElement(
      'p',
      { className: 'eyebrow' },
      isLocal ? 'Local development' : 'Single operator',
    ),
    createElement('h1', { id: 'login-title' }, 'Sign in to Agent OS'),
    createElement(
      'p',
      null,
      isLocal
        ? 'Bypass GitHub authentication for local testing or continue with GitHub.'
        : 'Continue with the GitHub account authorized for this control plane.',
    ),
    error
      ? createElement(
          'p',
          { className: 'notice error', role: 'alert', tabIndex: -1 },
          'GitHub sign-in could not be completed. Please try again.',
        )
      : null,
    createElement(
      'div',
      {
        className: 'button-row',
        style: { marginTop: '1rem', flexWrap: 'wrap' },
      },
      isLocal
        ? createElement(
            'a',
            { className: 'button', href: localAuthUrl, id: 'local-login-cta' },
            'Get In',
          )
        : null,
      createElement(
        'a',
        {
          className: isLocal ? 'button secondary' : 'button',
          href: githubAuthUrl,
        },
        'Continue with GitHub',
      ),
    ),
  );
}
