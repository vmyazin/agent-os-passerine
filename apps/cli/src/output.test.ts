import { describe, expect, it } from 'vitest';

import { renderResult } from './output.js';

describe('CLI output', () => {
  it('emits stable JSON with one trailing newline', () => {
    expect(renderResult({ z: 1, a: { d: 2, c: 1 } }, true)).toBe(
      '{"a":{"c":1,"d":2},"z":1}\n',
    );
  });

  it('renders concise aligned human tables without ANSI for non-TTY output', () => {
    const output = renderResult(
      [
        { id: 'run_1', status: 'running', pipeline: 'feature' },
        { id: 'run_2', status: 'failed', pipeline: 'goal' },
      ],
      false,
    );
    expect(output).toContain('ID');
    expect(output).toContain('run_1');
    expect(output).not.toContain(String.fromCharCode(27));
  });
});
