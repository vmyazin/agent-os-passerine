import { createElement, type ReactNode } from 'react';

const LABELS = {
  pending: 'Pending',
  running: 'Running',
  waiting: 'Waiting',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

export function RunStatusBadge({
  status,
}: {
  readonly status: keyof typeof LABELS;
}) {
  const label = LABELS[status];
  return createElement(
    'span',
    {
      'aria-label': `Run status: ${label}`,
      className: `status status-${status}`,
    },
    label,
  );
}

export function EmptyState({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return createElement(
    'section',
    { className: 'empty-state', role: 'status' },
    createElement('h2', null, title),
    createElement('p', null, children),
  );
}
