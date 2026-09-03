// src/ui/copy-log-button.tsx
'use client';

import { useState } from 'react';

import { CopyIcon } from './icons';

/**
 * Copies a step's log as plain text.
 *
 * The log is the thing an operator wants out of this page and cannot get:
 * reading a failure back to someone means retyping it or screenshotting it.
 * The text is built on the server, so what is copied is exactly what is
 * shown, in order, rather than whatever the DOM happens to contain.
 *
 * It lives inside the step's `<summary>`, so it must not toggle the
 * disclosure it sits in -- clicking copy should copy, not collapse the thing
 * being copied.
 */
export function CopyLogButton({
  text,
  label,
}: {
  readonly text: string;
  /** Names the control, since it shows only a glyph. */
  readonly label: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      // A denied permission, an insecure origin, or a browser without the
      // API. Saying so beats a button that silently does nothing.
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2_000);
  };

  return (
    <button
      aria-label={label}
      className="step-copy"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void copy();
      }}
      title={label}
      type="button"
    >
      <CopyIcon className="button-icon" />
      <span aria-live="polite" className="step-copy-state">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : ''}
      </span>
    </button>
  );
}
