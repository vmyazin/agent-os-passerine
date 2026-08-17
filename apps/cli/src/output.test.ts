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

  it('orders non-ASCII JSON keys without consulting the host locale', () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error('locale-dependent ordering used');
    };
    try {
      expect(renderResult({ ä: 1, z: 2, a: 3 }, true)).toBe(
        '{"a":3,"z":2,"ä":1}\n',
      );
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it('renders readable bounded goal progress without ANSI', () => {
    const output = renderResult(
      {
        id: 'run_1',
        status: 'running',
        goal: {
          currentStep: 1,
          maxSteps: 3,
          criteria: [
            { id: 'tests', description: 'Tests pass', required: true },
          ],
          latestResults: [
            { criterionId: 'tests', step: 1, status: 'failed', code: 'failed' },
          ],
          children: [{ step: 1, runId: 'run_child', status: 'failed' }],
        },
      },
      false,
    );
    expect(output).toContain('Goal step: 1/3');
    expect(output).toContain('Tests pass: failed (failed)');
    expect(output).toContain('Attempt 1: run_child (failed)');
    expect(output).not.toContain(String.fromCharCode(27));
  });
});
