import { describe, expect, it } from 'vitest';

import {
  draftPublicationResultSchema,
  localPublicationResultSchema,
  publicationResultSchema,
} from './schemas.js';

const validDraft = {
  status: 'succeeded' as const,
  draft: true as const,
  pullRequestUrl: 'https://github.com/team-zork/sandbox/pull/1',
};

const validLocal = {
  status: 'succeeded' as const,
  local: true as const,
  branch: 'agentos/run-1-abcdef01',
  commitSha: '0'.repeat(40),
  repositoryUrl: 'file:///workspaces/exp',
};

describe('localPublicationResultSchema', () => {
  it('accepts the local-git publisher result shape', () => {
    expect(localPublicationResultSchema.safeParse(validLocal).success).toBe(
      true,
    );
  });

  it('rejects a repositoryUrl that is not a file:// URL', () => {
    const result = localPublicationResultSchema.safeParse({
      ...validLocal,
      repositoryUrl: 'https://example.test/repo',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a commitSha that is not 40 lowercase hex characters', () => {
    const result = localPublicationResultSchema.safeParse({
      ...validLocal,
      commitSha: 'not-a-sha',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty branch', () => {
    const result = localPublicationResultSchema.safeParse({
      ...validLocal,
      branch: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields (strict)', () => {
    const result = localPublicationResultSchema.safeParse({
      ...validLocal,
      extra: 'field',
    });
    expect(result.success).toBe(false);
  });

  it('rejects the draft-PR shape (missing local/branch/commitSha/repositoryUrl)', () => {
    expect(localPublicationResultSchema.safeParse(validDraft).success).toBe(
      false,
    );
  });
});

describe('publicationResultSchema', () => {
  it('accepts the draft-PR publisher result shape', () => {
    expect(publicationResultSchema.safeParse(validDraft).success).toBe(true);
  });

  it('accepts the local-git publisher result shape', () => {
    expect(publicationResultSchema.safeParse(validLocal).success).toBe(true);
  });

  it('rejects extra fields on the draft arm', () => {
    const result = publicationResultSchema.safeParse({
      ...validDraft,
      extra: 'field',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields on the local arm', () => {
    const result = publicationResultSchema.safeParse({
      ...validLocal,
      extra: 'field',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a value matching neither arm', () => {
    const result = publicationResultSchema.safeParse({
      status: 'succeeded',
      draft: true,
      // missing pullRequestUrl, and not a local shape either
    });
    expect(result.success).toBe(false);
  });
});

// draftPublicationResultSchema is unchanged by the union addition; a quick
// sanity check that it still behaves exactly as before.
describe('draftPublicationResultSchema', () => {
  it('still accepts the draft-PR shape on its own', () => {
    expect(draftPublicationResultSchema.safeParse(validDraft).success).toBe(
      true,
    );
  });
});
