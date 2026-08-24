import { createAppAuth, type InstallationAuthOptions } from '@octokit/auth-app';

import {
  assertValidCommitPage,
  COMMIT_PAGE_SIZE,
  githubProjectSourceKey,
  isoTimestamp,
  type CommitPage,
  type GitHubProjectSource,
  type ProjectSourceInspection,
} from '@agentos/core';

const API_BASE = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAGE = 400;
const SHA = /^[0-9a-f]{40}$/;
const CANONICAL_REPOSITORY =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

type Auth = (input: Readonly<Record<string, unknown>>) => Promise<unknown>;

interface ReaderDependencies {
  readonly readerAuth: Auth;
  readonly publisherAuth?: Auth;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export interface GitHubProjectSourceInspectionResult {
  readonly inspection: ProjectSourceInspection;
  readonly repositoryId: number;
  readonly readerInstallationId: number;
  readonly publisherInstallationId?: number;
}

export interface GitHubProjectSourceReader {
  inspect(repositoryUrl: string): Promise<GitHubProjectSourceInspectionResult>;
  listCommits(
    source: GitHubProjectSource,
    cursor?: string,
  ): Promise<CommitPage>;
}

export class GitHubProjectSourceError extends Error {
  override readonly name = 'GitHubProjectSourceError';
  public constructor(
    public readonly code:
      | 'invalid_repository_url'
      | 'missing_reader_installation'
      | 'repository_mismatch'
      | 'unavailable_branch'
      | 'invalid_cursor'
      | 'provider_unavailable',
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : undefined;
}

function boundedPossiblyEmptyString(
  value: unknown,
  maximum: number,
): string | undefined {
  return typeof value === 'string' && value.length <= maximum
    ? value
    : undefined;
}

async function responseText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  )
    throw new GitHubProjectSourceError(
      'provider_unavailable',
      'GitHub returned an invalid response',
    );
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GitHubProjectSourceError(
        'provider_unavailable',
        'GitHub returned too much data',
      );
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubProjectSourceError(
      'provider_unavailable',
      'GitHub returned invalid text',
    );
  }
}

async function request(
  fetchImplementation: typeof globalThis.fetch,
  path: string,
  token: string,
): Promise<{ readonly response: Response; readonly value: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(`${API_BASE}${path}`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'agentos-project-import',
        'x-github-api-version': '2022-11-28',
      },
    });
    const text = await responseText(response);
    let value: unknown;
    try {
      value = text === '' ? null : JSON.parse(text);
    } catch {
      throw new GitHubProjectSourceError(
        'provider_unavailable',
        'GitHub returned malformed JSON',
      );
    }
    return { response, value };
  } catch (error) {
    if (error instanceof GitHubProjectSourceError) throw error;
    throw new GitHubProjectSourceError(
      'provider_unavailable',
      'GitHub is temporarily unavailable',
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function appToken(auth: Auth): Promise<string> {
  let result: unknown;
  try {
    result = await auth({ type: 'app' });
  } catch {
    throw new GitHubProjectSourceError(
      'provider_unavailable',
      'GitHub App authentication failed',
    );
  }
  const parsed = record(result);
  const token = boundedString(parsed?.token, 4096);
  if (parsed?.type !== 'app' || token === undefined || /\s/.test(token))
    throw new GitHubProjectSourceError(
      'provider_unavailable',
      'GitHub App authentication failed',
    );
  return token;
}

async function discoverInstallation(
  auth: Auth,
  fetchImplementation: typeof globalThis.fetch,
  owner: string,
  name: string,
): Promise<number | undefined> {
  const token = await appToken(auth);
  const result = await request(
    fetchImplementation,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    token,
  );
  if (result.response.status === 404) return undefined;
  if (!result.response.ok)
    throw new GitHubProjectSourceError(
      'provider_unavailable',
      'GitHub could not inspect the repository installation',
    );
  const id = positiveInteger(record(result.value)?.id);
  if (id === undefined)
    throw new GitHubProjectSourceError(
      'provider_unavailable',
      'GitHub returned an invalid installation',
    );
  return id;
}

async function installationToken(
  auth: Auth,
  installationId: number,
  repositoryName: string,
  now: Date,
): Promise<{ readonly token: string; readonly repositoryId: number }> {
  let value: unknown;
  try {
    value = await auth({
      type: 'installation',
      installationId,
      repositoryNames: [repositoryName],
      permissions: { contents: 'read' },
      refresh: true,
    });
  } catch {
    throw new GitHubProjectSourceError(
      'provider_unavailable',
      'GitHub repository authentication failed',
    );
  }
  const result = record(value);
  const repositoryIds = Array.isArray(result?.repositoryIds)
    ? result.repositoryIds
    : [];
  const permissions = record(result?.permissions);
  const token = boundedString(result?.token, 4096);
  const expiresAt = boundedString(result?.expiresAt, 100);
  const repositoryId = positiveInteger(repositoryIds[0]);
  const safePermissions =
    permissions !== undefined &&
    Object.entries(permissions).every(
      ([key, access]) =>
        (key === 'contents' && access === 'read') ||
        (key === 'metadata' && access === 'read') ||
        access === 'none',
    );
  if (
    result?.type !== 'token' ||
    result.tokenType !== 'installation' ||
    result.installationId !== installationId ||
    result.repositorySelection !== 'selected' ||
    repositoryIds.length !== 1 ||
    repositoryId === undefined ||
    permissions?.contents !== 'read' ||
    !safePermissions ||
    token === undefined ||
    /\s/.test(token) ||
    expiresAt === undefined ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= now.getTime()
  )
    throw new GitHubProjectSourceError(
      'provider_unavailable',
      'GitHub repository authentication failed',
    );
  return { token, repositoryId };
}

function repositoryParts(repositoryUrl: string): {
  owner: string;
  name: string;
} {
  const match = CANONICAL_REPOSITORY.exec(repositoryUrl);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[2].toLowerCase().endsWith('.git')
  )
    throw new GitHubProjectSourceError(
      'invalid_repository_url',
      'Use a canonical https://github.com/owner/repository URL',
    );
  return { owner: match[1], name: match[2] };
}

function pageFromCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  if (cursor.length > 2_048)
    throw new GitHubProjectSourceError(
      'invalid_cursor',
      'The commit cursor is invalid',
    );
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as {
      readonly version?: unknown;
      readonly page?: unknown;
    };
    if (
      decoded.version !== 1 ||
      typeof decoded.page !== 'number' ||
      !Number.isSafeInteger(decoded.page) ||
      decoded.page < 2 ||
      decoded.page > MAX_PAGE
    )
      throw new Error('invalid cursor');
    return decoded.page;
  } catch {
    throw new GitHubProjectSourceError(
      'invalid_cursor',
      'The commit cursor is invalid',
    );
  }
}

function cleanText(value: string, maximum: number, fallback = ''): string {
  const clean = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return (clean || fallback).slice(0, maximum);
}

function createReader(
  dependencies: ReaderDependencies,
): GitHubProjectSourceReader {
  const now = dependencies.now ?? (() => new Date());
  return Object.freeze({
    async inspect(
      repositoryUrl: string,
    ): Promise<GitHubProjectSourceInspectionResult> {
      const { owner, name } = repositoryParts(repositoryUrl);
      const readerInstallationId = await discoverInstallation(
        dependencies.readerAuth,
        dependencies.fetch,
        owner,
        name,
      );
      if (readerInstallationId === undefined)
        throw new GitHubProjectSourceError(
          'missing_reader_installation',
          'Install the AgentOS reader GitHub App on this repository first',
        );
      const auth = await installationToken(
        dependencies.readerAuth,
        readerInstallationId,
        name,
        now(),
      );
      const repositoryResult = await request(
        dependencies.fetch,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        auth.token,
      );
      if (!repositoryResult.response.ok)
        throw new GitHubProjectSourceError(
          'provider_unavailable',
          'GitHub could not inspect the repository',
        );
      const repository = record(repositoryResult.value);
      const repositoryId = positiveInteger(repository?.id);
      const defaultBranch = boundedString(repository?.default_branch, 255);
      if (
        repositoryId !== auth.repositoryId ||
        repository?.full_name !== `${owner}/${name}` ||
        repository?.name !== name ||
        repository?.html_url !== repositoryUrl
      )
        throw new GitHubProjectSourceError(
          'repository_mismatch',
          'The GitHub repository identity changed during inspection',
        );
      if (defaultBranch === undefined)
        throw new GitHubProjectSourceError(
          'unavailable_branch',
          'The GitHub repository has no available default branch',
        );
      const headResult = await request(
        dependencies.fetch,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(defaultBranch)}`,
        auth.token,
      );
      const headSha = boundedString(record(headResult.value)?.sha, 40);
      if (
        !headResult.response.ok ||
        headSha === undefined ||
        !SHA.test(headSha)
      )
        throw new GitHubProjectSourceError(
          'unavailable_branch',
          'The GitHub default branch is unavailable',
        );

      let publisherInstallationId: number | undefined;
      if (dependencies.publisherAuth !== undefined) {
        try {
          publisherInstallationId = await discoverInstallation(
            dependencies.publisherAuth,
            dependencies.fetch,
            owner,
            name,
          );
        } catch {
          publisherInstallationId = undefined;
        }
      }
      return {
        inspection: {
          kind: 'github',
          sourceKey: githubProjectSourceKey(owner, name),
          canonicalLocation: repositoryUrl,
          suggestedName: name,
          defaultBranch,
          headSha,
          publisherReady: publisherInstallationId !== undefined,
        },
        repositoryId,
        readerInstallationId,
        ...(publisherInstallationId === undefined
          ? {}
          : { publisherInstallationId }),
      };
    },

    async listCommits(
      source: GitHubProjectSource,
      cursor?: string,
    ): Promise<CommitPage> {
      const page = pageFromCursor(cursor);
      const auth = await installationToken(
        dependencies.readerAuth,
        source.readerInstallationId,
        source.name,
        now(),
      );
      if (auth.repositoryId !== source.repositoryId)
        throw new GitHubProjectSourceError(
          'repository_mismatch',
          'The GitHub repository identity changed',
        );
      const result = await request(
        dependencies.fetch,
        `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.name)}/commits?sha=${encodeURIComponent(source.defaultBranch)}&per_page=${String(COMMIT_PAGE_SIZE)}&page=${String(page)}`,
        auth.token,
      );
      if (!result.response.ok || !Array.isArray(result.value))
        throw new GitHubProjectSourceError(
          'provider_unavailable',
          'GitHub commit history is temporarily unavailable',
        );
      try {
        const items = result.value.map((entry) => {
          const row = record(entry);
          const commit = record(row?.commit);
          const author = record(commit?.author);
          const committer = record(commit?.committer);
          const sha = boundedString(row?.sha, 40);
          const message = boundedPossiblyEmptyString(commit?.message, 100_000);
          const authorName = boundedPossiblyEmptyString(author?.name, 10_000);
          const committedAt = boundedString(
            author?.date ?? committer?.date,
            100,
          );
          const url = boundedString(row?.html_url, 4096);
          if (
            sha === undefined ||
            !SHA.test(sha) ||
            message === undefined ||
            authorName === undefined ||
            committedAt === undefined ||
            url === undefined ||
            url !== `${source.repositoryUrl}/commit/${sha}`
          )
            throw new Error('malformed commit');
          return {
            sha,
            subject: cleanText(message.split(/\r?\n/, 1)[0] ?? '', 500),
            authorName: cleanText(authorName, 200, 'Unknown author'),
            committedAt: isoTimestamp(committedAt),
            url,
          };
        });
        const commitPage: CommitPage = {
          items,
          ...(items.length === COMMIT_PAGE_SIZE && page < MAX_PAGE
            ? {
                nextCursor: Buffer.from(
                  JSON.stringify({ version: 1, page: page + 1 }),
                ).toString('base64url'),
              }
            : {}),
        };
        assertValidCommitPage(commitPage);
        return commitPage;
      } catch (error) {
        if (error instanceof GitHubProjectSourceError) throw error;
        throw new GitHubProjectSourceError(
          'provider_unavailable',
          'GitHub returned malformed commit history',
        );
      }
    },
  });
}

export interface GitHubAppCredentials {
  readonly appId: number;
  readonly privateKey: string;
}

export interface GitHubProjectSourceReaderOptions {
  readonly readerApp: GitHubAppCredentials;
  readonly publisherApp?: GitHubAppCredentials;
  readonly fetch?: typeof globalThis.fetch;
}

function appAuth(credentials: GitHubAppCredentials): Auth {
  if (!Number.isSafeInteger(credentials.appId) || credentials.appId <= 0)
    throw new TypeError('GitHub App ID must be a positive safe integer');
  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  });
  return (input) => auth(input as InstallationAuthOptions);
}

export function createGitHubProjectSourceReader(
  options: GitHubProjectSourceReaderOptions,
): GitHubProjectSourceReader {
  return createReader({
    readerAuth: appAuth(options.readerApp),
    ...(options.publisherApp === undefined
      ? {}
      : { publisherAuth: appAuth(options.publisherApp) }),
    fetch: options.fetch ?? globalThis.fetch,
  });
}

export function createGitHubProjectSourceReaderForTest(
  dependencies: ReaderDependencies,
): GitHubProjectSourceReader {
  return createReader(dependencies);
}
