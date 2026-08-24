// src/ui/start-run-model.test.ts
import { describe, expect, it } from 'vitest';

import { submittableCriteria } from './start-run-model';

describe('submittableCriteria', () => {
  it('drops the row the operator has not filled in yet', () => {
    // The form opens with a row ready to type into, and "Add criterion" adds
    // another. Submitting a blank one fails the schema, and the operator is
    // told their request "did not match the schema" next to a form that
    // looks finished.
    expect(
      submittableCriteria([
        { description: 'content loads', command: 'pnpm test' },
        { description: '', command: 'pnpm test' },
      ]),
    ).toEqual([
      {
        id: 'criterion-1',
        type: 'command',
        description: 'content loads',
        command: 'pnpm test',
      },
    ]);
  });

  it('numbers ids over the rows it keeps', () => {
    // Numbering by original position would leave a gap, and two goals with
    // the same criteria would not agree on ids.
    expect(
      submittableCriteria([
        { description: '  ', command: 'pnpm test' },
        { description: 'first real', command: 'pnpm test' },
        { description: 'second real', command: 'pnpm typecheck' },
      ]).map((criterion) => criterion.id),
    ).toEqual(['criterion-1', 'criterion-2']);
  });

  it('trims what it keeps and refuses a row with no command', () => {
    expect(
      submittableCriteria([
        { description: '  spaced  ', command: 'pnpm test' },
        { description: 'no command', command: '' },
      ]),
    ).toEqual([
      {
        id: 'criterion-1',
        type: 'command',
        description: 'spaced',
        command: 'pnpm test',
      },
    ]);
  });

  it('is empty when nothing is filled in', () => {
    expect(submittableCriteria([{ description: '', command: '' }])).toEqual([]);
  });
});
