import { NextResponse } from 'next/server';

import { parseAgentOsConfig } from '@agentos/core';

import {
  controlPlaneService,
  ReaderConfigurationError,
  repositoryHeadResolverFromEnv,
} from '../../../../src/application/runtime';
import { ServiceError } from '../../../../src/application/control-plane-service';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolves the bound repository's current default-branch head: with the
 * trusted read-only GitHub App for a GitHub-bound project, or by running
 * `git rev-parse` against the containment-checked working tree for a local
 * experiment project (`repositoryHeadResolverFromEnv()` branches
 * internally on `config.project.localPath`). The wizard refreshes this
 * before starting a run so a stale SHA cannot produce a base mismatch at
 * publication.
 */
export function GET(request: Request): Promise<Response> {
  return handleApi(
    request,
    { authorize: () => requireApiAuthentication(request) },
    async () => {
      const active = await controlPlaneService().getConfiguration(true);
      if (active.active?.canonicalConfig === undefined) {
        throw new ServiceError(
          'no_active_configuration',
          'apply a configuration before resolving the repository head',
          409,
        );
      }
      // Construction itself never throws (it just builds closures); the
      // trusted reader is only ever built -- and validated -- lazily, the
      // first time resolve() actually needs the GitHub arm, so
      // ReaderConfigurationError can only surface from the resolve() call
      // below.
      const resolver = repositoryHeadResolverFromEnv();
      const config = parseAgentOsConfig(
        JSON.parse(active.active.canonicalConfig),
      );
      try {
        return await resolver.resolve(config);
      } catch (error) {
        if (error instanceof ReaderConfigurationError)
          throw new ServiceError(
            'reader_unavailable',
            error.message.slice(0, 500),
            503,
          );
        throw new ServiceError(
          'repository_head_unavailable',
          error instanceof Error
            ? error.message.slice(0, 500)
            : 'repository head resolution failed',
          502,
        );
      }
    },
  );
}

export function POST(): Response {
  return NextResponse.json(
    { error: { code: 'method_not_allowed', message: 'only GET is supported' } },
    { status: 405, headers: { allow: 'GET' } },
  );
}
