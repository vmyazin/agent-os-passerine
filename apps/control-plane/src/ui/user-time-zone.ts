import { DEFAULT_TIME_ZONE } from '@agentos/core';

import { controlPlaneService } from '../application/runtime';

export async function loadUserTimeZone(login: string): Promise<string> {
  return (
    (await controlPlaneService().getUserPreferences(login))?.timeZone ??
    DEFAULT_TIME_ZONE
  );
}
