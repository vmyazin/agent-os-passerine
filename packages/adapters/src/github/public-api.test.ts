import { describe, expect, expectTypeOf, it } from 'vitest';

import * as publicApi from '../index.js';
import type { TrustedGitHubPublisherService } from '../index.js';

// @ts-expect-error Raw GitHub clients are package-internal.
import type { GitHubInstallationClient } from '../index.js';
// @ts-expect-error Raw GitHub client factories are package-internal.
import type { GitHubInstallationClientFactory } from '../index.js';
// @ts-expect-error Installation scope is package-internal.
import type { InstallationClientScope } from '../index.js';

describe('trusted GitHub publisher public API', () => {
  it('exports only the composite trusted service factory', () => {
    expect(publicApi).toHaveProperty('createTrustedGitHubPublisherService');
    expect(publicApi).not.toHaveProperty('createGitHubAppClientFactory');
    expect(publicApi).not.toHaveProperty('createTrustedGitHubPublisher');
    expect(publicApi).not.toHaveProperty('InMemoryPublicationStore');
    expectTypeOf<TrustedGitHubPublisherService>().toHaveProperty('publish');
    expectTypeOf<TrustedGitHubPublisherService>().toHaveProperty('cancel');
    expectTypeOf<TrustedGitHubPublisherService>().toHaveProperty('status');
  });
});

void (0 as unknown as GitHubInstallationClient);
void (0 as unknown as GitHubInstallationClientFactory);
void (0 as unknown as InstallationClientScope);
