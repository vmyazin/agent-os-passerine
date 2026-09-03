import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PreviewRunAction, type RunPreviewView } from './mutation-forms';

function render(initialPreview: RunPreviewView | null) {
  return renderToStaticMarkup(
    createElement(PreviewRunAction, { runId: 'run_local', initialPreview }),
  );
}

describe('PreviewRunAction', () => {
  it('offers a start button when nothing is running', () => {
    const markup = render(null);

    expect(markup).toContain('Start preview');
    expect(markup).not.toContain('Stop');
    expect(markup).not.toContain('<a ');
  });

  it('links to the running server and names the script it started', () => {
    const markup = render({
      status: 'running',
      url: 'http://localhost:4321',
      script: 'dev',
    });

    expect(markup).toContain(
      '<a href="http://localhost:4321" rel="noreferrer" target="_blank">',
    );
    expect(markup).toContain('<code>dev</code>');
    expect(markup).toContain('Stop');
    expect(markup).not.toContain('Start preview');
  });

  it('shows what to do by hand when the branch has no server, and still offers Stop', () => {
    const markup = render({
      status: 'no_server',
      hint: 'This project declares no dev or start script. Run its tests with: cd /tmp/agentos-preview-a && pnpm test',
    });

    expect(markup).toContain('declares no dev or start script');
    expect(markup).toContain('Stop');
    expect(markup).not.toContain('<a ');
  });

  it('announces outcomes in a live region', () => {
    expect(render(null)).toContain('aria-live="polite"');
  });
});

describe('PreviewRunAction root-path guidance', () => {
  it('says the root is a 404 and links the paths the request named', () => {
    const markup = renderToStaticMarkup(
      createElement(PreviewRunAction, {
        runId: 'run-1',
        initialPreview: {
          status: 'running',
          url: 'http://localhost:58284',
          script: 'start',
          rootStatus: 404,
        },
        suggestedPaths: ['/health'],
      }),
    );
    expect(markup).toContain('answers 404 at the root');
    expect(markup).toContain('href="http://localhost:58284/health"');
  });
});
