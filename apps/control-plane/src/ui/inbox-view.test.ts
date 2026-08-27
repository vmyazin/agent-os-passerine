import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '@agentos/core';

import type {
  ApprovalProjection,
  InboxProjection,
  RunNotificationProjection,
} from '../application/control-plane-service';
import {
  createInboxConversation,
  createInboxItems,
  formatRelativeTime,
  inboxItemChip,
  inboxItemForRun,
  inboxItemNeedsAttention,
  inboxItemPreview,
  inboxItemSubject,
  inboxMessageLines,
  splitInboxItems,
} from './inbox-view-model';

const approval: ApprovalProjection = {
  id: 'approval_release',
  runId: 'run_release',
  scopeHash: 'sha256:release-scope',
  scopePreview: 'Publish the reviewed patch as a draft pull request',
  status: 'pending',
  createdAt: isoTimestamp('2026-08-17T11:00:00.000Z'),
  expiresAt: isoTimestamp('2026-08-18T11:00:00.000Z'),
};

const question: InboxProjection = {
  id: 'inbox_window',
  runId: 'run_release',
  status: 'pending',
  body: {
    question: 'Which deployment window should we use?',
    options: ['Tuesday morning', 'Thursday afternoon'],
  },
  createdAt: isoTimestamp('2026-08-17T12:00:00.000Z'),
};

describe('inbox view model', () => {
  it('combines request types newest first with deterministic keys', () => {
    const items = createInboxItems([approval], [question]);

    expect(items.map((item) => item.key)).toEqual([
      'question:inbox_window',
      'approval:approval_release',
    ]);
  });

  it('turns safe message content into human-readable copy', () => {
    const [item] = createInboxItems([], [question]);

    expect(inboxMessageLines(question.body)).toEqual([
      'Which deployment window should we use?',
    ]);
    expect(inboxItemSubject(item!)).toBe(
      'Which deployment window should we use?',
    );
    expect(inboxItemPreview(item!)).toBe('2 suggested options');
  });

  it('keeps approval scope as preview content instead of a subject', () => {
    const [item] = createInboxItems([approval], []);

    expect(inboxItemSubject(item!)).toBe('Approval requested');
    expect(inboxItemPreview(item!)).toBe(
      'Publish the reviewed patch as a draft pull request',
    );
  });

  it('labels a completed question as replied in the queue', () => {
    const [item] = createInboxItems(
      [],
      [
        {
          ...question,
          status: 'replied',
          reply: { text: 'Use Tuesday morning.' },
          repliedAt: isoTimestamp('2026-08-17T12:05:00.000Z'),
        },
      ],
    );

    expect(inboxItemPreview(item!)).toBe('Reply sent');
  });

  it('retains the original message and sent reply as conversation history', () => {
    const conversation = createInboxConversation({
      ...question,
      status: 'replied',
      reply: { text: 'Use Tuesday morning.' },
      repliedAt: isoTimestamp('2026-08-17T12:05:00.000Z'),
    });

    expect(conversation).toEqual([
      {
        author: 'agent',
        at: '2026-08-17T12:00:00.000Z',
        lines: ['Which deployment window should we use?'],
      },
      {
        author: 'operator',
        at: '2026-08-17T12:05:00.000Z',
        lines: ['Use Tuesday morning.'],
      },
    ]);
  });

  it('keeps a decided approval in the list as read-only history', () => {
    const [item] = createInboxItems(
      [
        {
          ...approval,
          status: 'consumed',
          decision: 'approved',
          consumedAt: isoTimestamp('2026-08-17T13:00:00.000Z'),
        },
      ],
      [],
    );

    expect(inboxItemNeedsAttention(item!)).toBe(false);
    expect(inboxItemPreview(item!)).toBe(
      'You approved this scope; the run continued.',
    );
    expect(inboxItemChip(item!)).toEqual({
      label: 'Approved',
      tone: 'positive',
    });
  });

  it('keeps approved scope details available in a collapsed disclosure', () => {
    const source = readFileSync(
      new URL('./inbox-view.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('<summary>Scope details</summary>');
    expect(source).toMatch(
      /decided && summary !== undefined[\s\S]*?<details className="inbox-evidence inbox-scope-details">[\s\S]*?<ApprovalScopeSummary approval=\{approval\} \/>/,
    );
  });

  it('renders a rejected approval with a negative chip', () => {
    const [item] = createInboxItems(
      [{ ...approval, status: 'consumed', decision: 'rejected' }],
      [],
    );

    expect(inboxItemChip(item!)).toEqual({
      label: 'Rejected',
      tone: 'negative',
    });
  });

  it('splits pending work from history without dropping anything', () => {
    const items = createInboxItems(
      [approval, { ...approval, id: 'approval_done', status: 'consumed' }],
      [question],
    );
    const { attention, history } = splitInboxItems(items);

    expect(attention.map((item) => item.key).sort()).toEqual([
      'approval:approval_release',
      'question:inbox_window',
    ]);
    expect(history.map((item) => item.key)).toEqual([
      'approval:approval_done',
    ]);
    expect(attention.length + history.length).toBe(items.length);
  });

  it('selects the newest pending message for a deep-linked run', () => {
    const items = createInboxItems([approval], [question]);

    expect(inboxItemForRun(items, 'run_release')?.key).toBe(
      'question:inbox_window',
    );
    expect(inboxItemForRun(items, 'run_missing')).toBeUndefined();
  });

  it('summarizes a completed run notification with outcome and spend', () => {
    const notification: RunNotificationProjection = {
      runId: 'run_release',
      pipeline: 'feature',
      title: 'Add CSV export',
      runStatus: 'succeeded',
      resultStatus: 'succeeded',
      outcome: { localBranch: 'agentos/run-release-1a2b3c4d' },
      totalCostUsd: 5.95,
      completedAt: isoTimestamp('2026-08-17T14:00:00.000Z'),
    };
    const [item] = createInboxItems([], [], [notification]);

    expect(inboxItemSubject(item!)).toBe('Run complete: Add CSV export ✓');
    expect(inboxItemPreview(item!)).toBe(
      'Local branch agentos/run-release-1a2b3c4d. Total spend: $5.95.',
    );
    expect(inboxItemChip(item!)).toEqual({
      label: 'Completed',
      tone: 'positive',
    });
    expect(inboxItemNeedsAttention(item!)).toBe(false);
  });

  it('labels failed and rejected runs distinctly', () => {
    const failed: RunNotificationProjection = {
      runId: 'run_broken',
      pipeline: 'feature',
      runStatus: 'failed',
      resultStatus: 'failed',
      reason: 'verification step exceeded its budget',
      completedAt: isoTimestamp('2026-08-17T15:00:00.000Z'),
    };
    const rejected: RunNotificationProjection = {
      runId: 'run_vetoed',
      pipeline: 'goal',
      runStatus: 'failed',
      resultStatus: 'rejected',
      completedAt: isoTimestamp('2026-08-17T16:00:00.000Z'),
    };
    const [rejectedItem, failedItem] = createInboxItems(
      [],
      [],
      [failed, rejected],
    );

    expect(inboxItemSubject(failedItem!)).toBe('Run failed');
    expect(inboxItemPreview(failedItem!)).toBe(
      'verification step exceeded its budget',
    );
    expect(inboxItemChip(failedItem!).tone).toBe('negative');
    expect(inboxItemSubject(rejectedItem!)).toBe('Goal rejected');
  });

  it('formats relative timestamps against a fixed now', () => {
    const now = '2026-08-17T12:00:00.000Z';

    expect(formatRelativeTime(now, '2026-08-17T11:59:40.000Z')).toBe(
      'just now',
    );
    expect(formatRelativeTime(now, '2026-08-17T11:36:00.000Z')).toBe(
      '24m ago',
    );
    expect(formatRelativeTime(now, '2026-08-17T07:00:00.000Z')).toBe('5h ago');
    expect(formatRelativeTime(now, '2026-08-14T12:00:00.000Z')).toBe('3d ago');
    expect(formatRelativeTime(now, '2026-08-01T12:00:00.000Z')).toBe('Aug 1');
  });
});
