import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  EmptyState,
  MetricCard,
  RunStatusBadge,
  RunStepTimeline,
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
