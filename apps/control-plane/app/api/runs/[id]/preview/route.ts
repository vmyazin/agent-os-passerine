// app/api/runs/[id]/preview/route.ts
import { fileURLToPath } from 'node:url';

import { controlPlaneService } from '../../../../../src/application/runtime';
import { AuthError } from '../../../../../src/auth/auth';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  assertNoQuery,
  boundedPathId,
  runPreviewSchema,
  runPreviewStoppedSchema,
} from '../../../../../src/http/contracts';
import {
  getRunPreview,
  isRunPreviewAvailable,
  RunPreviewError,
  startRunPreview,
  stopRunPreview,
  type RunPreview,
} from '../../../../../src/local-system/run-preview';

/**
 * Starting, reading and stopping the preview of one run's delivered code.
 *
 * Running model-written code outside the sandbox is the operator's own act,
 * so this is gated exactly like the folder picker: a browser session on a
 * localhost deployment. A CLI token is deliberately refused -- an automation
 * holding one must never be able to make this machine run a run's output.
 */

export const runtime = 'nodejs';

function authorize(request: Request): void {
  const identity = requireApiAuthentication(request);
  if (identity.kind !== 'session') {
    throw new AuthError(
      'browser_session_required',
      'A browser session is required to preview a run.',
      403,
    );
  }
  if (!isRunPreviewAvailable()) {
    throw new RunPreviewError(
      'run_preview_unavailable',
      'Previewing a run is only available on a local deployment.',
      404,
    );
  }
  assertNoQuery(request);
}

/**
 * Where this run's work landed on this machine. A GitHub run's result is a
 * draft pull request -- there is nothing here to check out -- so it is turned
 * away by its own code rather than failing somewhere inside git.
 */
async function localTarget(runId: string): Promise<{
  readonly repository: string;
  readonly branch: string;
}> {
  const run = await controlPlaneService().getRun(runId);
  if (run.status !== 'succeeded') {
    throw new RunPreviewError(
      'run_preview_not_succeeded',
      'Only a run that succeeded has delivered code to preview.',
      409,
    );
  }
  const branch = run.outcome?.publishedBranch ?? run.outcome?.localBranch;
  const repositoryUrl = run.outcome?.localRepositoryUrl;
  if (branch === undefined || repositoryUrl === undefined) {
    throw new RunPreviewError(
      'run_preview_not_local',
      'This run published nothing to a repository on this machine.',
      409,
    );
  }
  let repository: string;
  try {
    repository = fileURLToPath(repositoryUrl);
  } catch {
    throw new RunPreviewError(
      'run_preview_not_local',
      'This run’s repository is not a path on this machine.',
      409,
    );
  }
  return { repository, branch };
}

export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    { authorize: () => authorize(request), output: runPreviewSchema },
    async (): Promise<RunPreview> => {
      const { id } = await context.params;
      const runId = boundedPathId(id);
      // Idempotent: asking twice hands back the preview already running
      // rather than paying for a second checkout and install.
      const existing = getRunPreview(runId);
      if (existing !== undefined) return existing;
      const { repository, branch } = await localTarget(runId);
      return startRunPreview({ runId, repository, branch });
    },
  );
}

export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    { authorize: () => authorize(request), output: runPreviewSchema },
    async (): Promise<RunPreview> => {
      const { id } = await context.params;
      // Deliberately does not load the run: the page asks this on every
      // render, and the answer is already in memory.
      const preview = getRunPreview(boundedPathId(id));
      if (preview === undefined) {
        throw new RunPreviewError(
          'run_preview_not_started',
          'No preview is running for this run.',
          404,
        );
      }
      return preview;
    },
  );
}

export function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    { authorize: () => authorize(request), output: runPreviewStoppedSchema },
    async () => {
      const { id } = await context.params;
      await stopRunPreview(boundedPathId(id));
      return { stopped: true as const };
    },
  );
}
