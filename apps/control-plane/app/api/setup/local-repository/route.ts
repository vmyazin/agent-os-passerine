import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  initializeLocalRepository,
  LocalRepositoryAlreadyExistsError,
} from '@agentos/adapters';

import { localWorkspacesRootFromEnv } from '../../../../src/application/runtime';
import { ServiceError } from '../../../../src/application/control-plane-service';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const localRepositorySchema = z.union([
  z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(),
  // Auto-incrementing mode: the server picks the next free
  // `<namePrefix>-NN` directory so repeated e2e walkthroughs never collide.
  z
    .object({
      namePrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,58}$/),
    })
    .strict(),
]);

/** First free `<prefix>-NN` name under the root, starting at 01. */
async function nextAvailableName(
  root: string,
  prefix: string,
): Promise<string> {
  let existing: readonly string[];
  try {
    existing = await readdir(root);
  } catch {
    existing = [];
  }
  const pattern = new RegExp(`^${prefix}-(\\d{2,})$`);
  let highest = 0;
  for (const entry of existing) {
    const match = pattern.exec(entry);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${String(highest + 1).padStart(2, '0')}`;
}

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
      const packageManagerLine = await packageManagerLineFromMonorepoRoot();
      const create = async (name: string) => ({
        name,
        ...(await initializeLocalRepository({
          workspacesRoot: root,
          name,
          ...(packageManagerLine === undefined ? {} : { packageManagerLine }),
        })),
      });
      try {
        if ('name' in body) return await create(body.name);
        // Two attempts absorb a same-instant race on the incremented name;
        // beyond that the collision is real and surfaces as 409.
        try {
          return await create(await nextAvailableName(root, body.namePrefix));
        } catch (error) {
          if (!(error instanceof LocalRepositoryAlreadyExistsError))
            throw error;
          return await create(await nextAvailableName(root, body.namePrefix));
        }
      } catch (error) {
        if (error instanceof LocalRepositoryAlreadyExistsError)
          throw new ServiceError('already_exists', error.message, 409);
        throw error;
      }
    },
  );
}

export function GET(): Response {
  return NextResponse.json(
    { error: { code: 'method_not_allowed', message: 'only POST is supported' } },
    { status: 405, headers: { allow: 'POST' } },
  );
}
