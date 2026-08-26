import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyState, MetricCard, RunStatusBadge } from './components';

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
});
