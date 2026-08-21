import { describe, expect, it } from 'vitest';

import {
  definitionOfDoneSchema,
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

describe('definitionOfDoneSchema', () => {
  const valid = {
    version: 'definition-of-done-v2',
    criteria: [
      {
        id: 'list-deep-copy',
        description: 'Mutating a returned todo does not change the store',
        verifier: 'test-report',
      },
    ],
    acceptanceTests: [
      {
        path: 'test/acceptance/list-deep-copy.test.mjs',
        mode: '100644',
        content: "import { test } from 'node:test';\n",
      },
    ],
  };

  it('accepts a paired v2 document', () => {
    expect(definitionOfDoneSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects v1', () => {
    expect(
      definitionOfDoneSchema.safeParse({
        version: 'definition-of-done-v1',
        criteria: valid.criteria,
      }).success,
    ).toBe(false);
  });

  it('rejects a criterion without a matching file', () => {
    expect(
      definitionOfDoneSchema.safeParse({
        ...valid,
        acceptanceTests: [
          {
            path: 'test/acceptance/other.test.mjs',
            mode: '100644',
            content: 'x',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a path outside test/acceptance/', () => {
    expect(
      definitionOfDoneSchema.safeParse({
        ...valid,
        acceptanceTests: [
          {
            path: 'test/list-deep-copy.test.mjs',
            mode: '100644',
            content: 'x',
          },
        ],
      }).success,
    ).toBe(false);
  });
});
