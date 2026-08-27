// src/ui/format-timestamp.ts
import { DEFAULT_TIME_ZONE } from '@agentos/core';

function parsedDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Format an ISO timestamp for directory tables. */
export function formatDisplayDate(
  value: string,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const parsed = parsedDate(value);
  if (parsed === undefined) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(parsed);
}

export function formatDisplayDateTime(
  value: string,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const parsed = parsedDate(value);
  if (parsed === undefined) return value;
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZone,
    timeZoneName: 'short',
    year: 'numeric',
  }).format(parsed);
}

export function formatDisplayTime(
  value: string | Date,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const parsed = value instanceof Date ? value : parsedDate(value);
  if (parsed === undefined || Number.isNaN(parsed.getTime()))
    return typeof value === 'string' ? value : String(value);
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    second: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(parsed);
}
