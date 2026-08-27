// src/ui/time-of-day-greeting.ts
import { DEFAULT_TIME_ZONE } from '@agentos/core';

export function timeOfDayGreeting(
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .find((part) => part.type === 'hour')?.value,
  );

  if (hour >= 5 && hour < 12) {
    return 'Good morning';
  }

  if (hour >= 12 && hour < 17) {
    return 'Good afternoon';
  }

  return 'Good evening';
}
