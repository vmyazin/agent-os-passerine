import { notFound } from 'next/navigation';

import type { RunProjection } from './control-plane-service';
import { controlPlaneService } from './runtime';
import { boundedPathId } from '../http/contracts';

interface RunReader {
  getRun(id: string): Promise<RunProjection>;
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
