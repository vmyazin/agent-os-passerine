import {
  isoTimestamp,
  type IsoTimestamp,
  type Project,
  type ProjectId,
} from './persistence.js';

const GIT_SHA = /^[0-9a-f]{40}$/;
const MAX_BRANCH_LENGTH = 255;
const MAX_SOURCE_TEXT = 4096;
const MAX_COMMIT_SUBJECT = 500;
const MAX_AUTHOR_NAME = 200;
export const COMMIT_PAGE_SIZE = 25;

interface ProjectSourceBase {
  readonly projectId: ProjectId;
  readonly sourceKey: string;
  readonly defaultBranch: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface GitHubProjectSource extends ProjectSourceBase {
  readonly kind: 'github';
  readonly repositoryUrl: string;
  readonly owner: string;
  readonly name: string;
  readonly repositoryId: number;
  readonly readerInstallationId: number;
  readonly publisherInstallationId?: number;
}

export interface LocalProjectSource extends ProjectSourceBase {
  readonly kind: 'local';
  readonly localPath: string;
}

export type ProjectSource = GitHubProjectSource | LocalProjectSource;

export type ProjectSourceImportInput =
  | {
      readonly kind: 'github';
      readonly repositoryUrl: string;
    }
  | {
      readonly kind: 'local';
      readonly localPath: string;
      readonly defaultBranch?: string;
    };

export interface ProjectSourceInspection {
  readonly kind: ProjectSource['kind'];
  readonly sourceKey: string;
  readonly canonicalLocation: string;
  readonly suggestedName: string;
  readonly defaultBranch: string;
  readonly headSha: string;
  readonly publisherReady?: boolean;
}

export interface CommitSummary {
  readonly sha: string;
  readonly subject: string;
  readonly authorName: string;
  readonly committedAt: IsoTimestamp;
  readonly url?: string;
}

export interface CommitPage {
  readonly items: readonly CommitSummary[];
  readonly nextCursor?: string;
}

export interface ProjectSourceImportResult {
  readonly project: Project;
  readonly source: ProjectSource;
  readonly created: boolean;
}

export interface ProjectSourceImportRequest {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

export function assertValidProjectSourceImportRequest(
  request: ProjectSourceImportRequest,
): void {
  boundedText(request.idempotencyKey, 'idempotencyKey', 200);
  boundedText(request.fingerprint, 'fingerprint', 512);
}

export function githubProjectSourceKey(owner: string, name: string): string {
  return `github:${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function localProjectSourceKey(localPath: string): string {
  return `local:${localPath}`;
}

function boundedText(value: string, field: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum || value.includes('\0'))
    throw new TypeError(`${field} must be between 1 and ${maximum} characters`);
}

function positiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${field} must be a positive safe integer`);
}

function assertDefaultBranch(value: string): void {
  boundedText(value, 'defaultBranch', MAX_BRANCH_LENGTH);
}

export function assertValidProjectSource(source: ProjectSource): void {
  boundedText(source.sourceKey, 'sourceKey', MAX_SOURCE_TEXT);
  assertDefaultBranch(source.defaultBranch);
  isoTimestamp(source.createdAt);
  isoTimestamp(source.updatedAt);

  if (source.kind === 'local') {
    if (
      !source.localPath.startsWith('/') ||
      source.localPath.length > MAX_SOURCE_TEXT ||
      source.localPath.includes('\0') ||
      source.localPath.split('/').some((part) => part === '.' || part === '..')
    ) {
      throw new TypeError('localPath must be an absolute canonical path');
    }
    if (source.sourceKey !== localProjectSourceKey(source.localPath))
      throw new TypeError('sourceKey does not match local repository identity');
    return;
  }

  boundedText(source.owner, 'owner', 100);
  boundedText(source.name, 'name', 100);
  positiveSafeInteger(source.repositoryId, 'repositoryId');
  positiveSafeInteger(source.readerInstallationId, 'readerInstallationId');
  if (source.publisherInstallationId !== undefined)
    positiveSafeInteger(
      source.publisherInstallationId,
      'publisherInstallationId',
    );
  const expectedUrl = `https://github.com/${source.owner}/${source.name}`;
  if (source.repositoryUrl !== expectedUrl)
    throw new TypeError('repositoryUrl must match GitHub repository identity');
  if (source.sourceKey !== githubProjectSourceKey(source.owner, source.name))
    throw new TypeError('sourceKey does not match GitHub repository identity');
}

export function assertValidCommitPage(page: CommitPage): void {
  if (page.items.length > COMMIT_PAGE_SIZE)
    throw new TypeError(`commit page cannot exceed ${COMMIT_PAGE_SIZE} items`);
  if (page.nextCursor !== undefined)
    boundedText(page.nextCursor, 'nextCursor', 2048);

  for (const item of page.items) {
    if (!GIT_SHA.test(item.sha))
      throw new TypeError(
        'commit sha must be 40 lowercase hexadecimal characters',
      );
    if (item.subject.length > MAX_COMMIT_SUBJECT || item.subject.includes('\0'))
      throw new TypeError('commit subject is invalid');
    boundedText(item.authorName, 'commit author name', MAX_AUTHOR_NAME);
    isoTimestamp(item.committedAt);
    if (item.url !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(item.url);
      } catch {
        throw new TypeError('commit url must be HTTPS');
      }
      if (
        parsed.protocol !== 'https:' ||
        parsed.username !== '' ||
        parsed.password !== ''
      )
        throw new TypeError('commit url must be HTTPS');
    }
  }
}
