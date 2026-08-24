// src/ui/dispatch-diagnostics-model.test.ts
import { describe, expect, it } from 'vitest';

import {
  diagnoseDispatch,
  type DispatchRecord,
} from './dispatch-diagnostics-model';

const started: DispatchRecord = {
  kind: 'trigger-workflow-start',
  status: 'succeeded',
  externalRef: 'run_06g33ipgisln65a97pr2u7tb01',
};

describe('diagnoseDispatch', () => {
  it('separates the three failures that all look like "Pending"', () => {
    // Never handed off.
    expect(diagnoseDispatch({ records: [] })).toMatchObject({
      headline: 'Not handed off yet.',
      actionable: false,
    });

    // Handed off to nobody: the case that cost an afternoon.
    expect(
      diagnoseDispatch({
        records: [started],
        external: { status: 'PENDING_VERSION' },
      }),
    ).toMatchObject({
      headline: 'Handed off to Trigger.',
      externalRef: started.externalRef,
      actionable: true,
    });

    // The specific answer carries the remedy, so the page can retire its
    // generic "nothing picked it up" guidance.
    const pendingVersion = diagnoseDispatch({
      records: [started],
      external: { status: 'PENDING_VERSION' },
    });
    expect(pendingVersion?.fromExecutor).toBe(true);
    expect(pendingVersion?.remedy).toMatch(/trigger\.dev@latest dev/);
    // Rendered as text, so markup that never renders is worse than none.
    expect(pendingVersion?.remedy).not.toContain('`');

    // Handed off to a worker that died.
    const crashed = diagnoseDispatch({
      records: [started],
      external: {
        status: 'SYSTEM_FAILURE',
        error: 'COULD_NOT_FIND_EXECUTOR',
      },
    });
    expect(crashed?.detail).toContain('COULD_NOT_FIND_EXECUTOR');
    expect(crashed?.actionable).toBe(true);
  });

  it('blames source ingestion when that is what failed', () => {
    // It runs before dispatch, so nothing was ever handed off -- reporting
    // "not dispatched" would send the operator to look at Trigger.
    expect(
      diagnoseDispatch({
        records: [
          {
            kind: 'source-snapshot-ingest',
            status: 'failed',
            error: 'repository head is unavailable',
          },
        ],
      }),
    ).toMatchObject({
      headline:
        'Reading the repository failed, so the run was never dispatched.',
      detail: 'repository head is unavailable',
      actionable: true,
    });
  });

  it('says an expired run needs restarting, not waiting', () => {
    const expired = diagnoseDispatch({
      records: [started],
      external: { status: 'EXPIRED' },
    });
    expect(expired?.detail).toMatch(/gave up/);
    expect(expired?.actionable).toBe(true);
  });

  it('does not cry wolf while a worker is executing or queued', () => {
    for (const status of ['QUEUED', 'EXECUTING', 'DELAYED']) {
      expect(
        diagnoseDispatch({ records: [started], external: { status } })
          ?.actionable,
      ).toBe(false);
    }
  });

  it('admits when it cannot ask the executor', () => {
    const unknown = diagnoseDispatch({ records: [started] });
    expect(unknown?.detail).toMatch(/cannot query it/);
    expect(unknown?.actionable).toBe(false);
    // The page keeps its generic guidance in this case: a guess is better
    // than silence when nothing specific can be known.
    expect(unknown?.fromExecutor).toBe(false);
  });

  it('flags a Trigger run that finished while the domain run did not', () => {
    // Trigger says done, the control plane says pending: the break is
    // between the task and this database, and neither side would say so.
    expect(
      diagnoseDispatch({
        records: [started],
        external: { status: 'COMPLETED' },
      }),
    ).toMatchObject({ actionable: true });
  });
});
