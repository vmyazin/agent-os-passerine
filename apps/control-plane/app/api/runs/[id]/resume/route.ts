// app/api/runs/[id]/resume/route.ts
import {
  controlPlaneService,
  localExecutionState,
} from '../../../../../src/application/runtime';
import { loadRunDispatch } from '../../../../../src/application/run-page-model';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  boundedPathId,
  runProjectionSchema,
} from '../../../../../src/http/contracts';

/**
 * Continues a finished run where it stopped, reusing the steps it already
 * validated instead of paying a model to produce them again.
 *
 * The counterpart to restart, not a replacement: a resume re-enters the same
 * run, so it keeps that run's pinned configuration and repository snapshot.
 * When something was changed to make the work succeed, restart is the action
 * that picks the change up.
 */
export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: runProjectionSchema,
    },
    async () => {
      const { id } = await context.params;
      const runId = boundedPathId(id);
      // A queued run is retryable only when its newest handoff went to the
      // local executor and that executor has lost it (a restart) or failed
      // before recording a step. Anything else that is queued may still be
      // held by an executor this process cannot see.
      const dispatch = await loadRunDispatch(runId);
      const state =
        dispatch?.external ??
        (dispatch === undefined
          ? undefined
          : localExecutionState(
              [...dispatch.records]
                .reverse()
                .find((record) => record.externalRef !== undefined)
                ?.externalRef ?? '',
            ));
      const lostExecution =
        state?.status === 'LOST' || state?.status === 'FAILED';
      return controlPlaneService().resumeRun(runId, { lostExecution });
    },
  );
}
