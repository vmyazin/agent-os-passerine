import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyState, RunStatusBadge } from './components';

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
});
