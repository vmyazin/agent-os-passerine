// src/ui/run-live-refresh.tsx
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { formatDisplayTime } from './format-timestamp';

const REFRESH_MS = 10_000;

/**
 * Keeps a run page current while the run is not finished.
 *
 * A run changes on its own -- a worker claims it, a step finishes, an
 * approval is consumed -- and a static page makes the operator reload to
 * find out, which is indistinguishable from nothing happening. This refreshes
 * the server components in place rather than reloading, so scroll position
 * and any open detail survive.
 *
 * It says that it is doing so: a page that changes under you without
 * explanation is worse than one that does not change at all.
 */
export function RunLiveRefresh({
  live,
  timeZone,
}: {
  readonly live: boolean;
  readonly timeZone: string;
}) {
  const router = useRouter();
  const [refreshedAt, setRefreshedAt] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      router.refresh();
      setRefreshedAt(formatDisplayTime(new Date(), timeZone));
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, router, timeZone]);

  if (!live) return null;
  return (
    <span className="run-live" role="status">
      Updating every {String(REFRESH_MS / 1_000)}s
      {refreshedAt === undefined ? '' : ` · last checked ${refreshedAt}`}
    </span>
  );
}
