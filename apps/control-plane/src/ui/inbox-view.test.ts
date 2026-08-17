import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '@agentos/core';

import type {
  ApprovalProjection,
  InboxProjection,
} from '../application/control-plane-service';
import {
  createInboxItems,
  inboxItemPreview,
  inboxItemSubject,
  inboxMessageLines,
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
});
