import { describe, expect, it, vi } from 'vitest';

const notFound = vi.hoisted(() =>
  vi.fn((): never => {
    throw new Error('NOT_FOUND');
  }),
);

vi.mock('next/navigation', () => ({ notFound }));

import { loadRunPageModel } from './run-page-model';

describe('run detail page model', () => {
  it('rejects invalid path identifiers before repository access', async () => {
    const getRun = vi.fn();
    await expect(loadRunPageModel('../secret', { getRun })).rejects.toThrow(
      'NOT_FOUND',
    );
    expect(getRun).not.toHaveBeenCalled();
  });

  it('renders missing runs through the not-found boundary', async () => {
    const getRun = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('run not found'), { code: 'not_found' }),
      );
    await expect(loadRunPageModel('missing-run', { getRun })).rejects.toThrow(
      'NOT_FOUND',
    );
    expect(notFound).toHaveBeenCalled();
  });
});
