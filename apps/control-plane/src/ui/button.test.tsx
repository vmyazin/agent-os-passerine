import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Button, ButtonLink, buttonClassName } from './button';
import { CopyIcon } from './icons';

describe('Button', () => {
  it('is a primary, medium button by default', () => {
    const markup = renderToStaticMarkup(<Button>Save</Button>);
    expect(markup).toContain('class="btn btn-primary btn-md"');
    expect(markup).toContain('Save');
  });

  it('defaults its type to button, not submit', () => {
    // HTML defaults to submit, so a control inside a form submits it by
    // accident; the buttons that mean submit say so.
    expect(renderToStaticMarkup(<Button>Cancel</Button>)).toContain(
      'type="button"',
    );
    expect(renderToStaticMarkup(<Button type="submit">Send</Button>)).toContain(
      'type="submit"',
    );
  });

  it('carries weight and density by name', () => {
    const markup = renderToStaticMarkup(
      <Button size="sm" variant="quiet">
        Copy
      </Button>,
    );
    expect(markup).toContain('class="btn btn-quiet btn-sm"');
  });

  it('places a glyph before the label, sized under it', () => {
    const markup = renderToStaticMarkup(<Button icon={CopyIcon}>Copy</Button>);
    expect(markup).toContain('button-icon');
    expect(markup.indexOf('svg')).toBeLessThan(markup.indexOf('Copy'));
  });

  it('passes through what a button needs to behave', () => {
    const markup = renderToStaticMarkup(
      <Button aria-label="Copy the log" disabled title="Copy the log" />,
    );
    expect(markup).toContain('disabled');
    expect(markup).toContain('aria-label="Copy the log"');
    expect(markup).toContain('title="Copy the log"');
  });

  it('keeps a caller class alongside its own', () => {
    expect(
      buttonClassName({ className: 'dialog-close', variant: 'quiet' }),
    ).toBe('btn btn-quiet btn-md dialog-close');
  });

  it('renders navigation as a link that carries a button&rsquo;s weight', () => {
    // A link stays a link: it opens in a new tab, it can be copied, and it
    // works without JavaScript.
    const markup = renderToStaticMarkup(
      <ButtonLink href="/inbox" variant="secondary">
        View Inbox
      </ButtonLink>,
    );
    expect(markup).toContain('<a class="btn btn-secondary btn-md"');
    expect(markup).toContain('href="/inbox"');
    expect(markup).not.toContain('type=');
  });
});
