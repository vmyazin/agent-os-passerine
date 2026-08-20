// src/ui/format-timestamp.ts
const DISPLAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** Format an ISO timestamp for directory tables. */
export function formatDisplayDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return DISPLAY.format(parsed);
}
