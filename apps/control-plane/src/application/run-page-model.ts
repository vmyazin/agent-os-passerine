import { notFound } from 'next/navigation';

import type { RunProjection } from './control-plane-service';
import {
  controlPlaneService,
  externalRunStateFromEnv,
  workflowCheckpointsFromEnv,
} from './runtime';
import type {
  DispatchRecord,
  ExternalRunState,
} from '../ui/dispatch-diagnostics-model';
import { boundedPathId } from '../http/contracts';

interface RunReader {
  getRun(id: string): Promise<RunProjection>;
}

export function newestTriggerExternalRef(
  records: readonly DispatchRecord[],
): string | undefined {
  return newestStartRecord(records)?.externalRef;
}

/**
 * The most recent handoff. A resumed run has one start effect per generation
 * and the store lists effects by key, so "last in the list" is only the
 * newest by accident; the update time is what actually orders them.
 */
export function newestStartRecord(
  records: readonly DispatchRecord[],
): DispatchRecord | undefined {
  let newest: DispatchRecord | undefined;
  for (const record of records) {
    if (record.kind !== 'trigger-workflow-start') continue;
    if (record.externalRef === undefined) continue;
    if (
      newest === undefined ||
      (record.updatedAt ?? '') > (newest.updatedAt ?? '')
    )
      newest = record;
  }
  return newest;
}

export async function loadRunPageModel(
  rawId: string,
  service: RunReader = controlPlaneService(),
): Promise<RunProjection> {
  let id: string;
  try {
    id = boundedPathId(rawId);
  } catch {
    notFound();
  }
  try {
    return await service.getRun(id);
  } catch (error) {
    if (
      error instanceof Error &&
      (error as Error & { code?: unknown }).code === 'not_found'
    ) {
      notFound();
    }
    throw error;
  }
}

/**
 * Why a run has not started, assembled from the dispatch record this control
 * plane wrote and, where it can be asked, what the executor did with it.
 *
 * Everything here is best-effort and fails soft. It exists to explain a page
 * that is otherwise silent, so it must never be the reason that page fails
 * to render: no checkpoint store, no Trigger key, an unknown run id, or an
 * unreachable API each mean "say less", not "throw".
 */
export async function loadRunDispatch(runId: string): Promise<
  | {
      readonly records: readonly DispatchRecord[];
      readonly external?: ExternalRunState;
    }
  | undefined
> {
  let records: readonly DispatchRecord[];
  try {
    const checkpoints = workflowCheckpointsFromEnv();
    if (checkpoints === undefined) return undefined;
    const effects = await checkpoints.listEffects(runId);
    records = effects.flatMap((effect) =>
      effect.kind === 'source-snapshot-ingest' ||
      effect.kind === 'trigger-workflow-start'
        ? [
            {
              kind: effect.kind,
              status: effect.status,
              ...(effect.externalRef === undefined
                ? {}
                : { externalRef: effect.externalRef }),
              ...(effect.error === undefined
                ? {}
                : { error: effect.error.slice(0, 500) }),
              updatedAt: effect.updatedAt,
            },
          ]
        : [],
    );
  } catch {
    return undefined;
  }

  const externalRef = newestTriggerExternalRef(records);
  if (externalRef === undefined) return { records };
  const external = await externalRunStateFromEnv(externalRef);
  return { records, ...(external === undefined ? {} : { external }) };
}
