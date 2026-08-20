// src/ui/time-of-day-greeting.ts
const EASTERN_TIME_ZONE = 'America/New_York';

export function timeOfDayGreeting(now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: EASTERN_TIME_ZONE,
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
