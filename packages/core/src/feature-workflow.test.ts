import { describe, expect, it } from 'vitest';

import {
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
} from './attestation.js';
import {
  createFeatureWorkflow,
  reduceFeatureWorkflow,
  replayFeatureWorkflow,
  type FeatureWorkflowEvent,
} from './feature-workflow.js';
import type { RepositoryPublisherAttestationClaims } from './ports.js';

const event = (
  id: string,
  type: FeatureWorkflowEvent['type'],
): FeatureWorkflowEvent => ({ id, type }) as FeatureWorkflowEvent;

const publicationBinding = {
  scopeHash: 'scope-hash',
  actionHash: 'action-hash',
  baseSha: 'base-sha',
  patchHash: 'patch-hash',
} as const;
const publisherClaims: RepositoryPublisherAttestationClaims = {
  source: 'repository-publisher',
  ...publicationBinding,
};
const publisherKey = {
  keyId: 'publisher',
  secret: 'publisher-test-secret',
} as const;
const publisherIssuer =
  createHmacAttestationIssuer<RepositoryPublisherAttestationClaims>(
    publisherKey,
  );
const publisherVerifier =
  createHmacAttestationVerifier<RepositoryPublisherAttestationClaims>({
    keys: [publisherKey],
  });
const publisherContext = {
  publisherAttestationVerifier: publisherVerifier,
} as const;

const happyPath: FeatureWorkflowEvent[] = [
  event('1', 'specification_completed'),
  event('2', 'specification_approved'),
  event('3', 'plan_completed'),
  event('4', 'implementation_completed'),
  event('5', 'tests_passed'),
  event('6', 'review_passed'),
  event('7', 'policy_passed'),
  {
    id: '8',
    type: 'draft_published',
    publication: {
      id: 'pr-1',
      url: 'https://example.test/pr/1',
      draft: true,
      attestation: publisherIssuer.issue({
        kind: 'repository-draft-publication',
        subject: 'pr-1',
        claims: publisherClaims,
        issuedAt: '2026-08-16T20:00:00.000Z',
      }),
    },
  },
];

describe('feature workflow reducer', () => {
  it('runs specification through policy validation to draft publication', () => {
    const completed = replayFeatureWorkflow(
      happyPath,
      {
        maxRetries: 2,
        publicationBinding,
      },
      publisherContext,
    );

    expect(completed).toMatchObject({
      status: 'succeeded',
      phase: 'draft_publication',
    });
    expect(completed.publication?.draft).toBe(true);
  });

  it('fails when combined specification and DoD approval is rejected', () => {
    const rejected = replayFeatureWorkflow(
      [
        event('1', 'specification_completed'),
        {
          id: '2',
          type: 'specification_rejected',
          reason: 'DoD is incomplete',
        },
      ],
      { maxRetries: 2 },
    );

    expect(rejected).toMatchObject({
      status: 'failed',
      failureReason: 'DoD is incomplete',
    });
  });

  it('routes test, review, and policy failures through fixes and enforces retry limit', () => {
    let state = replayFeatureWorkflow(happyPath.slice(0, 4), { maxRetries: 1 });
    state = reduceFeatureWorkflow(state, event('failure-1', 'tests_failed'));
    expect(state.phase).toBe('fixing');
    state = reduceFeatureWorkflow(state, event('fix-1', 'fix_completed'));
    state = reduceFeatureWorkflow(state, event('failure-2', 'tests_failed'));

    expect(state).toMatchObject({
      status: 'failed',
      retryCount: 2,
      failureReason: 'retry_limit',
    });
  });

  it.each([
    ['cancel', 'cancelled'],
    ['exhaust_budget', 'budget_exhausted'],
  ] as const)('handles %s from an active phase', (type, status) => {
    expect(
      reduceFeatureWorkflow(
        createFeatureWorkflow({ maxRetries: 2 }),
        event('1', type),
      ).status,
    ).toBe(status);
  });

  it('supports crash/resume replay and ignores duplicate event IDs', () => {
    const events: FeatureWorkflowEvent[] = [
      event('1', 'specification_completed'),
      event('2', 'specification_approved'),
      event('3', 'crashed'),
      event('4', 'resume'),
      event('5', 'plan_completed'),
    ];
    const replayed = replayFeatureWorkflow(events, { maxRetries: 2 });
    const duplicated = replayFeatureWorkflow([...events, ...events], {
      maxRetries: 2,
    });

    expect(replayed).toMatchObject({
      status: 'running',
      phase: 'implementation',
      retryCount: 1,
    });
    expect(duplicated).toEqual(replayed);
    expect(reduceFeatureWorkflow(replayed, event('5', 'plan_completed'))).toBe(
      replayed,
    );
  });

  it('supports review/fix loops before policy validation', () => {
    const reviewed = replayFeatureWorkflow(
      [
        ...happyPath.slice(0, 5),
        event('review-1', 'review_changes_requested'),
        event('fix-1', 'fix_completed'),
        event('test-2', 'tests_passed'),
        event('review-2', 'review_passed'),
      ],
      { maxRetries: 2 },
    );

    expect(reviewed).toMatchObject({
      phase: 'policy_validation',
      status: 'running',
      retryCount: 1,
    });
  });

  it('preserves first-crash recovery metadata across repeated crashes and resumes cleanly', () => {
    let state = replayFeatureWorkflow([event('1', 'specification_completed')], {
      maxRetries: 2,
      publicationBinding,
    });
    state = reduceFeatureWorkflow(state, {
      id: 'crash-1',
      type: 'crashed',
      reason: 'provider disconnected',
    });
    state = reduceFeatureWorkflow(state, {
      id: 'crash-2',
      type: 'crashed',
      reason: 'duplicate disconnect notification',
    });

    expect(state).toMatchObject({
      status: 'blocked',
      phase: 'specification_approval',
      blockedFromStatus: 'awaiting_approval',
      failureReason: 'provider disconnected',
      retryCount: 1,
    });

    state = reduceFeatureWorkflow(state, event('resume', 'resume'));
    expect(state).toMatchObject({
      status: 'awaiting_approval',
      phase: 'specification_approval',
    });
    expect(state).not.toHaveProperty('blockedFromStatus');
    expect(state).not.toHaveProperty('failureReason');

    state = [...happyPath.slice(1)].reduce(
      (current, nextEvent) =>
        reduceFeatureWorkflow(current, nextEvent, publisherContext),
      state,
    );
    expect(state.status).toBe('succeeded');
  });

  it('rejects empty IDs and same-ID workflow payload collisions', () => {
    expect(() =>
      reduceFeatureWorkflow(
        createFeatureWorkflow({ maxRetries: 2 }),
        event('', 'specification_completed'),
      ),
    ).toThrow(/event id/i);
    const crashed = reduceFeatureWorkflow(
      createFeatureWorkflow({ maxRetries: 2 }),
      { id: 'collision', type: 'crashed', reason: 'first' },
    );
    expect(() =>
      reduceFeatureWorkflow(crashed, {
        id: 'collision',
        type: 'crashed',
        reason: 'different',
      }),
    ).toThrow(/different/i);
  });

  it('bounds the workflow dedupe snapshot window', () => {
    let state = reduceFeatureWorkflow(
      createFeatureWorkflow({ maxRetries: 2 }),
      { id: 'initial-crash', type: 'crashed' },
    );
    for (let index = 0; index < 300; index += 1) {
      state = reduceFeatureWorkflow(state, {
        id: `repeated-crash-${index}`,
        type: 'crashed',
      });
    }

    expect(state.processedEventIds).toHaveLength(256);
    expect(Object.keys(state.processedEventFingerprints ?? {})).toHaveLength(
      256,
    );
  });

  it('requires a trusted publisher attestation', () => {
    const ready = replayFeatureWorkflow(happyPath.slice(0, 7), {
      maxRetries: 2,
    });
    expect(() =>
      reduceFeatureWorkflow(ready, {
        id: 'untrusted-publication',
        type: 'draft_published',
        publication: {
          id: 'pr-2',
          url: 'https://example.test/pr/2',
          draft: true,
          attestation: {
            source: 'agent',
            scopeHash: 'scope-hash',
            actionHash: 'action-hash',
            baseSha: 'base-sha',
            patchHash: 'patch-hash',
          },
        },
      } as unknown as FeatureWorkflowEvent),
    ).toThrow(/attestation/i);
  });

  it('rejects a publisher token issued by a different authority', () => {
    const verifier =
      createHmacAttestationVerifier<RepositoryPublisherAttestationClaims>({
        keys: [
          { keyId: publisherKey.keyId, secret: 'different-publisher-secret' },
        ],
      });
    expect(() =>
      replayFeatureWorkflow(
        happyPath,
        { maxRetries: 2, publicationBinding },
        { publisherAttestationVerifier: verifier },
      ),
    ).toThrow(/attestation/i);
  });

  it('keeps verifier ports out of state and validates persisted publisher attestations through reduction context', () => {
    const key = { keyId: 'publisher', secret: 'publisher-secret' } as const;
    const issuer =
      createHmacAttestationIssuer<RepositoryPublisherAttestationClaims>(key);
    const verifier =
      createHmacAttestationVerifier<RepositoryPublisherAttestationClaims>({
        keys: [key],
      });
    const ready = replayFeatureWorkflow(happyPath.slice(0, 7), {
      maxRetries: 2,
      publicationBinding,
    });
    const persistedReady = JSON.parse(JSON.stringify(ready));
    const publication = JSON.parse(
      JSON.stringify({
        id: 'pr-persisted',
        url: 'https://example.test/pr/persisted',
        draft: true,
        attestation: issuer.issue({
          kind: 'repository-draft-publication',
          subject: 'pr-persisted',
          claims: publisherClaims,
          issuedAt: '2026-08-16T20:00:00.000Z',
        }),
      }),
    );

    expect(persistedReady).not.toHaveProperty('publisherAttestationVerifier');
    expect(
      reduceFeatureWorkflow(
        persistedReady,
        { id: 'persisted-publication', type: 'draft_published', publication },
        { publisherAttestationVerifier: verifier },
      ).status,
    ).toBe('succeeded');
  });
});
