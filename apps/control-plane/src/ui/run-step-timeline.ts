import { createElement } from 'react';

import { formatDisplayTime } from './format-timestamp';

export interface RunStepProgressEntry {
  readonly eventId: string;
  readonly phase: string;
  readonly message: string;
  readonly occurredAt: string;
}

export interface RunStepTimelineItem {
  readonly id: string;
  readonly stepKey: string;
  readonly attempt: number;
  readonly status: string;
  readonly model?: string;
  readonly progress: readonly RunStepProgressEntry[];
}

function fallbackStatus(status: string): string {
  switch (status) {
    case 'pending':
      return 'Queued';
    case 'running':
      return 'Working';
    case 'succeeded':
      return 'Step completed';
    case 'failed':
      return 'Step failed';
    default:
      return status;
  }
}

const eventTime = (value: string, timeZone: string) =>
  formatDisplayTime(value, timeZone);

export function RunStepTimeline({
  steps,
  timeZone = 'UTC',
}: {
  readonly steps: readonly RunStepTimelineItem[];
  readonly timeZone?: string;
}) {
  return createElement(
    'ol',
    { className: 'run-step-list' },
    ...steps.map((step) => {
      const latest =
        step.progress.at(-1)?.message ?? fallbackStatus(step.status);
      const events =
        step.progress.length === 0
          ? createElement(
              'p',
              { className: 'run-step-empty' },
              'No detailed activity was recorded.',
            )
          : createElement(
              'ol',
              {
                'aria-label': `${step.stepKey} activity`,
                className: 'run-step-events',
              },
              ...step.progress.map((event) =>
                createElement(
                  'li',
                  { 'data-phase': event.phase, key: event.eventId },
                  createElement(
                    'time',
                    { dateTime: event.occurredAt },
                    eventTime(event.occurredAt, timeZone),
                  ),
                  createElement('span', null, event.message),
                ),
              ),
            );
      return createElement(
        'li',
        { key: step.id },
        createElement(
          'details',
          { className: 'run-step' },
          createElement(
            'summary',
            { className: 'run-step-summary' },
            createElement(
              'span',
              { className: 'run-step-heading' },
              createElement('strong', null, step.stepKey),
              createElement('span', { className: 'run-step-current' }, latest),
            ),
            createElement(
              'span',
              { className: 'run-step-meta' },
              createElement(
                'span',
                null,
                `${step.status} · Attempt ${String(step.attempt)}`,
              ),
              step.model === undefined
                ? null
                : createElement('code', null, step.model),
            ),
          ),
          events,
        ),
      );
    }),
  );
}
