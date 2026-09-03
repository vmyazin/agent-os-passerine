import { createElement, type ReactNode } from 'react';

import { CopyLogButton } from './copy-log-button';
import { formatDisplayTime } from './format-timestamp';

export interface RunStepProgressEntry {
  readonly eventId: string;
  readonly phase: string;
  readonly message: string;
  /** The tail of the message that is code, set in monospace when present. */
  readonly code?: string;
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

/**
 * A progress line, with its code part in monospace.
 *
 * The message already contains the code, so this splits on that exact
 * substring rather than guessing at a separator: an event without a `code`
 * field, or one whose message does not end with it, renders as plain text
 * exactly as before.
 */
function renderMessage(event: {
  readonly message: string;
  readonly code?: string;
}): ReactNode[] {
  const { message, code } = event;
  if (code === undefined || code.length === 0) return [message];
  const at = message.lastIndexOf(code);
  if (at < 0 || at + code.length !== message.length) return [message];
  return [
    message.slice(0, at),
    createElement('code', { className: 'run-step-code', key: 'code' }, code),
  ];
}

/**
 * A step's log as plain text, for the clipboard.
 *
 * A header naming what this is, then one line per note in the order shown.
 * Built here rather than scraped from the DOM so the copy matches the page
 * exactly, and so it still works for a step whose notes are collapsed.
 */
export function stepLogText(
  step: {
    readonly stepKey: string;
    readonly attempt: number;
    readonly status: string;
    readonly model?: string;
    readonly progress: readonly {
      readonly message: string;
      readonly occurredAt: string;
    }[];
  },
  timeZone?: string,
): string {
  const header = [
    step.stepKey,
    `attempt ${String(step.attempt)}`,
    step.status,
    ...(step.model === undefined ? [] : [step.model]),
  ].join(' · ');
  const lines = step.progress.map(
    (event) =>
      `${formatDisplayTime(event.occurredAt, timeZone)}  ${event.message}`,
  );
  return [header, '', ...lines].join('\n');
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
                  createElement('span', null, ...renderMessage(event)),
                ),
              ),
            );
      return createElement(
        'li',
        {
          key: step.id,
          // The rail animates only for the step actually doing work, so the
          // one thing moving on the page is the thing that is moving.
          ...(step.status === 'running'
            ? { className: 'run-step-item-running' }
            : {}),
        },
        createElement(
          'details',
          { className: 'run-step' },
          createElement(
            'summary',
            { className: 'run-step-summary' },
            createElement(
              'span',
              { className: 'run-step-heading' },
              // The heading stacks the name over the latest note, so the
              // name and its copy control share a row of their own.
              createElement(
                'span',
                { className: 'run-step-name' },
                createElement('strong', null, step.stepKey),
                // Beside the name it belongs to, so it is obvious which log
                // gets copied even when several steps are on screen.
                createElement(CopyLogButton, {
                  key: 'copy',
                  // Retried steps repeat the name, so the attempt is part of
                  // the accessible name that tells the two controls apart.
                  label: `Copy the ${step.stepKey} log, attempt ${String(step.attempt)}`,
                  text: stepLogText(step, timeZone),
                }),
              ),
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
