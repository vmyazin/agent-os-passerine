import { describe, expect, it } from 'vitest';

import {
  definitionOfDoneSchema,
  draftPublicationResultSchema,
  localPublicationResultSchema,
  publicationResultSchema,
  artifactSchemaFailureMessage,
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

  it('rejects the live repository-escaping import before approval', () => {
    const parsed = definitionOfDoneSchema.safeParse({
      ...valid,
      acceptanceTests: [
        {
          path: 'test/acceptance/list-deep-copy.test.mjs',
          mode: '100644',
          content:
            "import { list } from '../../../src/todo-store.mjs';\n" +
            "import { test } from 'node:test';\n",
        },
      ],
    });

    expect(parsed.success).toBe(false);
    const issues = parsed.success ? [] : parsed.error.issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['acceptanceTests', 0, 'content'],
        }),
      ]),
    );
    const message = artifactSchemaFailureMessage(
      { stepId: 'specification', artifactId: 'dod' },
      issues,
    );
    expect(message).toContain('acceptanceTests.0.content');
    expect(message).not.toContain('../../../src/todo-store.mjs');
    expect(message).not.toContain('import { list }');
  });

  it('accepts the corrected repository-internal import', () => {
    expect(
      definitionOfDoneSchema.safeParse({
        ...valid,
        acceptanceTests: [
          {
            path: 'test/acceptance/list-deep-copy.test.mjs',
            mode: '100644',
            content: "import { list } from '../../src/todo-store.mjs';\n",
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('artifactSchemaFailureMessage', () => {
  it('names the artifact, its step, and the fields that failed', () => {
    // The case that cost a real run: a project whose applied configuration
    // still tells the specifier to write definition-of-done-v1.
    const parsed = definitionOfDoneSchema.safeParse({
      version: 'definition-of-done-v1',
      criteria: [
        { id: 'tests', description: 'Tests pass', verifier: 'test-report' },
      ],
    });
    expect(parsed.success).toBe(false);
    const message = artifactSchemaFailureMessage(
      { stepId: 'specification', artifactId: 'dod' },
      parsed.success ? [] : parsed.error.issues,
    );
    expect(message).toContain('specification');
    expect(message).toContain('"dod"');
    expect(message).toMatch(/version|acceptanceTests/);
  });

  it('reports paths and never the values behind them', () => {
    // An issue's received value is agent-authored; this message is stored on
    // the run and rendered to the operator.
    const message = artifactSchemaFailureMessage(
      { stepId: 'implementation', artifactId: 'changes' },
      [{ path: ['changes', 0, 'content'] }],
    );
    expect(message).toBe(
      'the implementation step\'s "changes" artifact did not match its required schema (changes.0.content)',
    );
  });

  it('still names the artifact when the failure has no path', () => {
    expect(
      artifactSchemaFailureMessage({ stepId: 'review', artifactId: 'review' }, [
        { path: [] },
      ]),
    ).toBe(
      'the review step\'s "review" artifact did not match its required schema',
    );
  });
});
