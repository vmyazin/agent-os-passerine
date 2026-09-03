import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CircleCheckIcon, GitBranchIcon } from './icons';

describe('vendored Lucide icons', () => {
  it('is hidden from assistive technology unless it is given a name', () => {
    // Status and actions here are named in text, so an icon beside a visible
    // word must not be announced twice.
    const decorative = renderToStaticMarkup(createElement(CircleCheckIcon, {}));
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain('role="img"');

    const named = renderToStaticMarkup(
      createElement(CircleCheckIcon, { title: 'Succeeded' }),
    );
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Succeeded"');
    expect(named).not.toContain('aria-hidden');
  });

  it('inherits colour and text size so it never introduces its own', () => {
    const markup = renderToStaticMarkup(createElement(GitBranchIcon, {}));
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('fill="none"');
    expect(markup).toContain('width="1em"');
    expect(markup).toContain('height="1em"');
  });

  it('keeps Lucide geometry, so a vendored icon still looks like the set', () => {
    // The exact path from lucide-static v1.39.0. If this changes, the icon
    // was redrawn rather than copied, and it will not match its neighbours.
    const markup = renderToStaticMarkup(createElement(GitBranchIcon, {}));
    expect(markup).toContain('M15 6a9 9 0 0 0-9 9V3');
    expect(markup).toContain('cx="18"');
  });

  it('accepts a size and an extra class without losing its own', () => {
    const markup = renderToStaticMarkup(
      createElement(CircleCheckIcon, { size: 16, className: 'status-icon' }),
    );
    expect(markup).toContain('width="16"');
    expect(markup).toContain('icon icon-circle-check status-icon');
  });
});
