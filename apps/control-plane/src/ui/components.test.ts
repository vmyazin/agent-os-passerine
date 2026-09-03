import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  EmptyState,
  MetricCard,
  RunStatusBadge,
  RunStepTimeline,
  stepLogText,
} from './components';

describe('control-plane UI components', () => {
  it('renders an explicit accessible empty state', () => {
    const markup = renderToStaticMarkup(
      createElement(EmptyState, {
        title: 'No runs yet',
        children: 'Create a feature or goal to begin.',
      }),
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('No runs yet');
  });

  it('announces run state without relying on color', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStatusBadge, { status: 'waiting' }),
    );
    expect(markup).toContain('Waiting');
    expect(markup).toContain('aria-label="Run status: Waiting"');
  });

  it('spins only while a run is actively moving', () => {
    for (const status of ['pending', 'running'] as const) {
      const markup = renderToStaticMarkup(
        createElement(RunStatusBadge, { status }),
      );
      expect(markup).toContain('class="status-spinner"');
    }

    for (const status of [
      'waiting',
      'succeeded',
      'failed',
      'cancelled',
    ] as const) {
      const markup = renderToStaticMarkup(
        createElement(RunStatusBadge, { status }),
      );
      expect(markup).not.toContain('status-spinner');
    }
  });

  it('renders a noninteractive metric card with article semantics', () => {
    const markup = renderToStaticMarkup(
      createElement(MetricCard, {
        label: 'Budget',
        value: '—',
        detail: 'Not configured',
      }),
    );

    expect(markup).toContain('<article class="metric-card">');
    expect(markup).toContain('class="metric-card-body"');
    expect(markup).toContain('Budget');
    expect(markup).toContain('Not configured');
    expect(markup).not.toMatch(/<a(?:\s|>)/);
  });

  it('renders a native full-card metric link when href is present', () => {
    const markup = renderToStaticMarkup(
      createElement(MetricCard, {
        label: 'Projects',
        value: 1,
        detail: '1 project',
        href: '/projects',
      }),
    );

    expect(markup).toContain('<article class="metric-card">');
    expect(markup).toContain('class="metric-card-body metric-card-link"');
    expect(markup).toContain('href="/projects"');
    expect(markup).toContain('Projects');
    expect(markup).toContain('1 project');
  });

  it('renders a step current status with an expandable chronological log', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStepTimeline, {
        steps: [
          {
            id: 'step-1',
            stepKey: 'specification',
            attempt: 1,
            status: 'running',
            model: 'kimi-k2.5',
            progress: [
              {
                eventId: 'event-1',
                phase: 'sending',
                message: 'Sending request to the model',
                occurredAt: '2026-08-27T19:00:00.000Z',
              },
              {
                eventId: 'event-2',
                phase: 'waiting',
                message: 'Waiting on response',
                occurredAt: '2026-08-27T19:00:01.000Z',
              },
            ],
          },
        ],
      }),
    );

    expect(markup).toContain('<details class="run-step">');
    expect(markup).toContain('<summary class="run-step-summary">');
    expect(markup).toContain('Waiting on response');
    expect(markup).toContain('Attempt 1');
    // The clock renders in the operator's zone and does not name it.
    expect(markup).toContain('19:00:00');
    expect(markup).not.toContain('19:00:00 UTC');
    expect(markup).toContain('aria-label="specification activity"');
  });
});

describe('RunStepTimeline running rail', () => {
  const step = (status: string) => ({
    id: `run-1:specification:1`,
    stepKey: 'specification',
    attempt: 1,
    status,
    progress: [
      {
        eventId: 'e1',
        phase: 'tool',
        message: 'read finished',
        occurredAt: '2026-09-03T00:00:00.000Z',
      },
    ],
  });

  it('marks only the running step, so one thing on the page moves', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStepTimeline, {
        steps: [step('succeeded'), step('running'), step('failed')],
      } as never),
    );
    expect(markup.match(/run-step-item-running/g)?.length ?? 0).toBe(1);
  });

  it('marks nothing when no step is running', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStepTimeline, {
        steps: [step('succeeded'), step('failed')],
      } as never),
    );
    expect(markup).not.toContain('run-step-item-running');
  });
});

describe('RunStepTimeline code rendering', () => {
  const withProgress = (message: string, code?: string) => ({
    id: 'run-1:specification:1',
    stepKey: 'specification',
    attempt: 1,
    status: 'running',
    progress: [
      {
        eventId: 'e1',
        phase: 'tool',
        message,
        occurredAt: '2026-09-03T00:00:00.000Z',
        ...(code === undefined ? {} : { code }),
      },
    ],
  });

  it('sets the code part of a message in monospace', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStepTimeline, {
        steps: [
          withProgress(
            'Model (kimi) is using bash: node --test',
            'node --test',
          ),
        ],
      } as never),
    );
    expect(markup).toContain('<code class="run-step-code">node --test</code>');
    expect(markup).toContain('is using bash: ');
  });

  it('leaves a message without a code part as plain text', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStepTimeline, {
        steps: [withProgress('Model sent a message: I could not find it')],
      } as never),
    );
    expect(markup).not.toContain('run-step-code');
    expect(markup).toContain('I could not find it');
  });

  it('renders plainly when the code is not the tail of the message', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStepTimeline, {
        steps: [withProgress('bash finished', 'something else entirely')],
      } as never),
    );
    expect(markup).not.toContain('run-step-code');
    expect(markup).toContain('bash finished');
  });
});

describe('RunStepTimeline copy action', () => {
  const step = {
    id: 'run-1:specification:1',
    stepKey: 'specification',
    attempt: 1,
    status: 'failed',
    model: 'kimi-k2.7-code',
    progress: [
      {
        eventId: 'e1',
        phase: 'preparing',
        message: 'Preparing workspace',
        occurredAt: '2026-09-03T05:08:17.000Z',
      },
      {
        eventId: 'e2',
        phase: 'tool',
        message: 'artifact_put reported an error: quota exhausted',
        occurredAt: '2026-09-03T05:08:22.000Z',
      },
    ],
  };

  it('offers a named copy control on each step', () => {
    const markup = renderToStaticMarkup(
      createElement(RunStepTimeline, {
        steps: [step],
        timeZone: 'UTC',
      } as never),
    );
    // Glyph-only, so it needs a name of its own rather than a nearby label.
    expect(markup).toContain(
      'aria-label="Copy the specification log, attempt 1"',
    );
    expect(markup).toContain('icon icon-copy');
  });

  it('builds the log as text: a header, then one line per note in order', () => {
    // Asserted on the builder rather than the markup: the text reaches the
    // clipboard through a prop the handler reads, so it is never rendered.
    const text = stepLogText(step, 'UTC');
    expect(text.split('\n')).toEqual([
      'specification · attempt 1 · failed · kimi-k2.7-code',
      '',
      '05:08:17  Preparing workspace',
      '05:08:22  artifact_put reported an error: quota exhausted',
    ]);
  });

  it('names a step with no model and no notes without inventing either', () => {
    const text = stepLogText(
      { stepKey: 'specification', attempt: 1, status: 'pending', progress: [] },
      'UTC',
    );
    expect(text).toBe('specification · attempt 1 · pending\n');
  });
});
