import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { initializeLocalRepository } from '@agentos/adapters';

import { localWorkspacesRootFromEnv } from '../../../../src/application/runtime';
import { ServiceError } from '../../../../src/application/control-plane-service';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const localRepositorySchema = z
  .object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) })
  .strict();

/**
 * Reads the monorepo root package.json's `packageManager` field so a newly
 * seeded experiment repo pins the same toolchain the control plane itself
 * runs under. Best-effort: a missing/unreadable/malformed root manifest
 * just means the seed repo's package.json omits the field, not a request
 * failure.
 */
async function packageManagerLineFromMonorepoRoot(): Promise<
  string | undefined
> {
  try {
    const raw = await readFile(
      resolve(process.cwd(), '../../package.json'),
      'utf8',
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'packageManager' in parsed &&
      typeof (parsed as { packageManager?: unknown }).packageManager ===
        'string'
    )
      return (parsed as { packageManager: string }).packageManager;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates and seeds a brand-new local experiment repository under
 * AGENTOS_LOCAL_WORKSPACES_ROOT. Session-authorized, like the rest of the
 * setup wizard's routes -- this never touches a repository the operator
 * didn't ask this endpoint to create.
 */
export function POST(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: localRepositorySchema,
      successStatus: 201,
    },
    async (body) => {
      const root = localWorkspacesRootFromEnv();
      if (root === undefined)
        throw new ServiceError(
          'local_workspaces_unconfigured',
          'set AGENTOS_LOCAL_WORKSPACES_ROOT to enable local experiments',
          409,
        );
      const target = join(root, body.name);
      const alreadyExists = await stat(target).then(
        () => true,
        () => false,
      );
      if (alreadyExists)
        throw new ServiceError(
          'already_exists',
          `a local repository named "${body.name}" already exists`,
          409,
        );
      const packageManagerLine = await packageManagerLineFromMonorepoRoot();
      return initializeLocalRepository({
        workspacesRoot: root,
        name: body.name,
        ...(packageManagerLine === undefined ? {} : { packageManagerLine }),
      });
    },
  );
}

export function GET(): Response {
  return NextResponse.json(
    { error: { code: 'method_not_allowed', message: 'only POST is supported' } },
    { status: 405, headers: { allow: 'POST' } },
  );
}
