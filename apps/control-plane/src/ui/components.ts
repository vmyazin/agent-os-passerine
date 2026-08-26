import { createElement, type ReactNode } from 'react';

const LABELS = {
  pending: 'Pending',
  running: 'Running',
  waiting: 'Waiting',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

/**
 * Statuses where work is actually in flight, and the badge should look like
 * it. `waiting` is deliberately excluded: it is not progressing, it is
 * blocked on the operator, and a spinner there would promise movement that
 * only their decision can produce.
 */
const IN_FLIGHT: ReadonlySet<string> = new Set(['pending', 'running']);

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
    // Decorative: the label already says the status, so a screen reader
    // gains nothing from it and a spinning element it cannot see is noise.
    IN_FLIGHT.has(status)
      ? createElement('span', {
          'aria-hidden': 'true',
          className: 'status-spinner',
          key: 'spinner',
        })
      : null,
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

export function MetricCard({
  label,
  value,
  detail,
  href,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly detail: ReactNode;
  readonly href?: string;
}) {
  const content = [
    createElement('span', { className: 'metric-label' }, label),
    createElement('strong', { className: 'metric-value' }, value),
    createElement('span', { className: 'metric-detail' }, detail),
  ];
  const body =
    href === undefined
      ? createElement('div', { className: 'metric-card-body' }, ...content)
      : createElement(
          'a',
          { className: 'metric-card-body metric-card-link', href },
          ...content,
        );

  return createElement('article', { className: 'metric-card' }, body);
}
