import { describe, expect, it } from 'vitest';

import {
  assertAcceptanceTestsParse,
  AcceptanceTestSyntaxError,
} from './acceptance-test-check.js';

const good = {
  path: 'test/acceptance/greet.test.mjs',
  content: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../../src/greet.mjs';

test('greets', () => {
  assert.equal(greet('a'), 'Hello, a!');
});
`,
};

describe('assertAcceptanceTestsParse', () => {
  it('accepts tests that parse, including ones importing code that does not exist yet', async () => {
    // The implementation is written after this check runs, so an unresolved
    // import must not be treated as a broken test.
    await expect(assertAcceptanceTestsParse([good])).resolves.toBeUndefined();
  });

  it('accepts an empty list', async () => {
    await expect(assertAcceptanceTestsParse([])).resolves.toBeUndefined();
  });

  it('refuses the import attribute Node removed', async () => {
    // The real 2026-09-02 failure: this raises a SyntaxError before the test
    // runs, so it fails every implementation including a correct one.
    const failing = {
      path: 'test/acceptance/start-script.test.mjs',
      content: `import { test } from 'node:test';
import pkg from '../../package.json' assert { type: 'json' };

test('has a start script', () => {
  if (!pkg.scripts.start) throw new Error('missing');
});
`,
    };
    await expect(assertAcceptanceTestsParse([failing])).rejects.toBeInstanceOf(
      AcceptanceTestSyntaxError,
    );
    await expect(assertAcceptanceTestsParse([failing])).rejects.toThrow(
      /start-script\.test\.mjs/,
    );
  });

  it('names every broken test and how many there are', async () => {
    const broken = (name: string) => ({
      path: `test/acceptance/${name}.test.mjs`,
      content: 'this is not javascript {{{',
    });
    await expect(
      assertAcceptanceTestsParse([good, broken('one'), broken('two')]),
    ).rejects.toThrow(/2 acceptance tests.*one\.test\.mjs.*two\.test\.mjs/s);
  });

  it('reports the path the specifier chose, not a temporary one', async () => {
    const failing = {
      path: 'test/acceptance/version-endpoint.test.mjs',
      content: 'const = ;',
    };
    const error = await assertAcceptanceTestsParse([failing]).then(
      () => undefined,
      (thrown: unknown) => thrown as AcceptanceTestSyntaxError,
    );
    expect(error).toBeInstanceOf(AcceptanceTestSyntaxError);
    if (error === undefined) throw new Error('expected a syntax error');
    expect(error.failures).toHaveLength(1);
    expect(error.failures[0]?.path).toBe(
      'test/acceptance/version-endpoint.test.mjs',
    );
    expect(error.message).not.toContain('agentos-dod-check-');
  });
});
