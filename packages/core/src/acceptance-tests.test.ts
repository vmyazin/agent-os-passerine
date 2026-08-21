// packages/core/src/acceptance-tests.test.ts
import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_TEST_PREFIX,
  AcceptancePathReservedError,
  acceptanceTestPathForCriterion,
  acceptanceTestsPairingError,
  isAcceptanceTestPath,
  sealChangeSet,
} from './acceptance-tests.js';

describe('acceptance test paths', () => {
  it('reserves the prefix case-insensitively', () => {
    expect(ACCEPTANCE_TEST_PREFIX).toBe('test/acceptance/');
    expect(isAcceptanceTestPath('test/acceptance/list-deep-copy.test.mjs')).toBe(
      true,
    );
    expect(isAcceptanceTestPath('TEST/ACCEPTANCE/x.test.mjs')).toBe(true);
    expect(isAcceptanceTestPath('test/todo-store.test.mjs')).toBe(false);
    expect(isAcceptanceTestPath('src/test/acceptance/x.test.mjs')).toBe(false);
  });

  it('pairs each criterion id to exactly one file', () => {
    expect(acceptanceTestPathForCriterion('list-deep-copy')).toBe(
      'test/acceptance/list-deep-copy.test.mjs',
    );
    expect(
      acceptanceTestsPairingError(['list-deep-copy'], [
        'test/acceptance/list-deep-copy.test.mjs',
      ]),
    ).toBeUndefined();
    expect(
      acceptanceTestsPairingError(['list-deep-copy'], [
        'test/acceptance/other.test.mjs',
      ]),
    ).toMatch(/pairing/);
    expect(
      acceptanceTestsPairingError(['a', 'b'], [
        'test/acceptance/a.test.mjs',
      ]),
    ).toMatch(/pairing/);
  });
});

describe('sealChangeSet', () => {
  const frozen = {
    path: 'test/acceptance/list-deep-copy.test.mjs',
    mode: '100644' as const,
    content: 'export {}\n',
  };

  it('rejects an implementer change under the reserved prefix', () => {
    expect(() =>
      sealChangeSet(
        [
          {
            operation: 'add',
            path: 'test/acceptance/list-deep-copy.test.mjs',
            mode: '100644',
            content: 'smuggled\n',
          },
        ],
        [frozen],
      ),
    ).toThrow(AcceptancePathReservedError);
  });

  it('overlays frozen files after the implementer changes', () => {
    const sealed = sealChangeSet(
      [
        {
          operation: 'add',
          path: 'src/todo-store.mjs',
          mode: '100644',
          content: 'export {}\n',
        },
      ],
      [frozen],
    );
    expect(sealed).toEqual([
      {
        operation: 'add',
        path: 'src/todo-store.mjs',
        mode: '100644',
        content: 'export {}\n',
      },
      {
        operation: 'add',
        path: frozen.path,
        mode: '100644',
        content: frozen.content,
      },
    ]);
  });

  it('uses modify when the source bundle already has the frozen path', () => {
    const sealed = sealChangeSet(
      [
        {
          operation: 'add',
          path: 'src/todo-store.mjs',
          mode: '100644',
          content: 'export {}\n',
        },
      ],
      [frozen],
      new Set([frozen.path]),
    );
    expect(sealed.at(-1)).toMatchObject({
      operation: 'modify',
      path: frozen.path,
      content: frozen.content,
    });
  });
});
