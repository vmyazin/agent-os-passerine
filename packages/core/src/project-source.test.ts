import { describe, expect, it } from 'vitest';

import {
  assertValidCommitPage,
  assertValidProjectSource,
  assertValidProjectSourceImportRequest,
  githubProjectSourceKey,
  localProjectSourceKey,
  type CommitPage,
  type ProjectSource,
} from './project-source.js';
import { isoTimestamp, persistenceId } from './persistence.js';

const projectId = persistenceId('project', 'project-1');
const at = isoTimestamp('2026-08-24T12:00:00.000Z');

describe('project source contracts', () => {
  it('normalizes GitHub identity without changing the canonical URL fields', () => {
    expect(githubProjectSourceKey('Team-Zork', 'Passerine')).toBe(
      'github:team-zork/passerine',
    );
  });

  it('uses the exact canonical local path as its identity', () => {
    expect(localProjectSourceKey('/workspaces/Passerine')).toBe(
      'local:/workspaces/Passerine',
    );
  });

  it('accepts a bounded GitHub source and rejects a mismatched source key', () => {
    const source: ProjectSource = {
      kind: 'github',
      projectId,
      sourceKey: 'github:team-zork/passerine',
      repositoryUrl: 'https://github.com/team-zork/passerine',
      owner: 'team-zork',
      name: 'passerine',
      repositoryId: 42,
      readerInstallationId: 7,
      defaultBranch: 'main',
      createdAt: at,
      updatedAt: at,
    };

    expect(() => assertValidProjectSource(source)).not.toThrow();
    expect(() =>
      assertValidProjectSource({ ...source, sourceKey: 'github:other/repo' }),
    ).toThrow('sourceKey does not match GitHub repository identity');
  });

  it('accepts an exact local source and rejects relative paths', () => {
    const source: ProjectSource = {
      kind: 'local',
      projectId,
      sourceKey: 'local:/workspaces/passerine',
      localPath: '/workspaces/passerine',
      defaultBranch: 'main',
      createdAt: at,
      updatedAt: at,
    };

    expect(() => assertValidProjectSource(source)).not.toThrow();
    expect(() =>
      assertValidProjectSource({
        ...source,
        sourceKey: 'local:relative/repo',
        localPath: 'relative/repo',
      }),
    ).toThrow('localPath must be an absolute canonical path');
  });

  it('bounds durable import request identity', () => {
    expect(() =>
      assertValidProjectSourceImportRequest({
        idempotencyKey: 'import-1',
        fingerprint: 'sha256:request',
      }),
    ).not.toThrow();
    expect(() =>
      assertValidProjectSourceImportRequest({
        idempotencyKey: 'x'.repeat(201),
        fingerprint: 'sha256:request',
      }),
    ).toThrow('idempotencyKey must be between 1 and 200 characters');
  });
});

describe('commit page contracts', () => {
  it('accepts bounded commit metadata without exposing author email', () => {
    const page: CommitPage = {
      items: [
        {
          sha: 'a'.repeat(40),
          subject: 'Import an existing project',
          authorName: 'VM',
          committedAt: at,
          url:
            'https://github.com/team-zork/passerine/commit/' + 'a'.repeat(40),
        },
      ],
      nextCursor: 'page-2',
    };

    expect(() => assertValidCommitPage(page)).not.toThrow();
    expect(page.items[0]).not.toHaveProperty('authorEmail');
  });

  it('rejects malformed SHAs and pages larger than 25 commits', () => {
    expect(() =>
      assertValidCommitPage({
        items: [
          {
            sha: 'not-a-sha',
            subject: 'bad',
            authorName: 'VM',
            committedAt: at,
          },
        ],
      }),
    ).toThrow('commit sha must be 40 lowercase hexadecimal characters');

    expect(() =>
      assertValidCommitPage({
        items: Array.from({ length: 26 }, () => ({
          sha: 'b'.repeat(40),
          subject: 'too many',
          authorName: 'VM',
          committedAt: at,
        })),
      }),
    ).toThrow('commit page cannot exceed 25 items');
  });
});
