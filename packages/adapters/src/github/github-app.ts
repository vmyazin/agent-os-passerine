import { createAppAuth, type InstallationAuthOptions } from '@octokit/auth-app';

import { GitHubPublisherError } from './errors.js';
import type {
  GitHubInstallationClient,
  GitHubInstallationClientFactory,
  GitTreeEntry,
  InstallationClientScope,
  PullRequest,
} from './types.js';

const OFFICIAL_API_BASE = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 20_000;
const GIT_SHA = /^[0-9a-f]{40}$/;

type InstallationAuth = (
  input: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

interface FactoryDependencies {
  readonly auth: InstallationAuth;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function sha(value: unknown): string | undefined {
  const parsed = string(value);
  return parsed !== undefined && GIT_SHA.test(parsed) ? parsed : undefined;
}

function fail(message = 'GitHub API request failed'): never {
  throw new GitHubPublisherError('github_unavailable', message);
}

async function boundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    fail();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function repositoryPath(scope: InstallationClientScope): string {
  return `/repos/${pathSegment(scope.owner)}/${pathSegment(scope.name)}`;
}

function verifyAuthResult(
  value: unknown,
  scope: InstallationClientScope,
  now: Date,
): string {
  const result = record(value);
  const permissions = record(result?.permissions);
  const repositoryIds = Array.isArray(result?.repositoryIds)
    ? result.repositoryIds
    : undefined;
  const permittedKeys = new Set(['contents', 'pull_requests', 'metadata']);
  const unexpectedPermission =
    permissions === undefined ||
    Object.entries(permissions).some(
      ([key, access]) =>
        (!permittedKeys.has(key) && access !== 'none') ||
        (key === 'metadata' && access !== 'read'),
    );
  const expiresAt = string(result?.expiresAt);
  const token = string(result?.token);
  if (
    result?.type !== 'token' ||
    result.tokenType !== 'installation' ||
    result.installationId !== scope.installationId ||
    result.repositorySelection !== 'selected' ||
    repositoryIds === undefined ||
    repositoryIds.length !== 1 ||
    Number(repositoryIds[0]) !== scope.repositoryId ||
    permissions?.contents !== 'write' ||
    permissions.pull_requests !== 'write' ||
    unexpectedPermission ||
    token === undefined ||
    token.length === 0 ||
    token.length > 4096 ||
    /\s/.test(token) ||
    expiresAt === undefined ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= now.getTime()
  ) {
    throw new GitHubPublisherError(
      'github_unavailable',
      'GitHub App installation authentication failed',
    );
  }
  return token;
}

function parsePullRequest(value: unknown): PullRequest {
  const response = record(value);
  const head = record(response?.head);
  const base = record(response?.base);
  const headRepositoryId = positiveInteger(record(head?.repo)?.id);
  const baseRepositoryId = positiveInteger(record(base?.repo)?.id);
  const number = positiveInteger(response?.number);
  const url = string(response?.html_url);
  const body = string(response?.body);
  const headRef = string(head?.ref);
  const baseRef = string(base?.ref);
  if (
    number === undefined ||
    url === undefined ||
    !url.startsWith('https://github.com/') ||
    response?.draft !== true ||
    body === undefined ||
    headRef === undefined ||
    baseRef === undefined ||
    headRepositoryId === undefined ||
    baseRepositoryId === undefined
  ) {
    fail();
  }
  return {
    number,
    url,
    draft: true,
    head: headRef,
    base: baseRef,
    headRepositoryId,
    baseRepositoryId,
    body,
  };
}

function createClient(
  scope: InstallationClientScope,
  token: string,
  fetchImplementation: typeof globalThis.fetch,
): GitHubInstallationClient {
  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    notFoundIsUndefined = false,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImplementation(
        `${OFFICIAL_API_BASE}${path}`,
        {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-github-api-version': '2026-03-10',
            'user-agent': 'agentos-trusted-publisher/1',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: 'error',
        },
      );
      const text = await boundedResponseText(response);
      if (notFoundIsUndefined && response.status === 404) return undefined;
      if (!response.ok) fail();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        fail();
      }
    } catch (error) {
      if (error instanceof GitHubPublisherError) throw error;
      fail();
    } finally {
      clearTimeout(timeout);
    }
  };
  const repo = repositoryPath(scope);

  const client: GitHubInstallationClient = {
    async getRepository() {
      const value = record(await request('GET', repo));
      const id = positiveInteger(value?.id);
      const fullName = string(value?.full_name);
      const defaultBranch = string(value?.default_branch);
      if (
        id === undefined ||
        fullName === undefined ||
        defaultBranch === undefined
      )
        fail();
      return { id, fullName, defaultBranch };
    },
    async getReference(branch: string) {
      const value = await request(
        'GET',
        `${repo}/git/ref/${pathSegment(`heads/${branch}`)}`,
        undefined,
        true,
      );
      if (value === undefined) return undefined;
      const object = record(record(value)?.object);
      const commitSha = sha(object?.sha);
      if (commitSha === undefined) fail();
      return { sha: commitSha };
    },
    async getCommit(commitSha: string) {
      const value = record(
        await request('GET', `${repo}/git/commits/${pathSegment(commitSha)}`),
      );
      const responseSha = sha(value?.sha);
      const treeSha = sha(record(value?.tree)?.sha);
      const message = string(value?.message);
      const rawParents = Array.isArray(value?.parents)
        ? value.parents
        : undefined;
      const parents = rawParents?.map((parent) => sha(record(parent)?.sha));
      if (
        responseSha === undefined ||
        responseSha !== commitSha ||
        treeSha === undefined ||
        message === undefined ||
        parents === undefined ||
        parents.some((parent) => parent === undefined)
      ) {
        fail();
      }
      return {
        sha: responseSha,
        treeSha,
        message,
        parents: parents as string[],
      };
    },
    async getTree(treeSha: string) {
      const value = record(
        await request(
          'GET',
          `${repo}/git/trees/${pathSegment(treeSha)}?recursive=1`,
        ),
      );
      const responseSha = sha(value?.sha);
      const rawEntries = Array.isArray(value?.tree) ? value.tree : undefined;
      if (
        responseSha === undefined ||
        responseSha !== treeSha ||
        rawEntries === undefined ||
        typeof value?.truncated !== 'boolean'
      )
        fail();
      const entries: GitTreeEntry[] = rawEntries.map((raw) => {
        const entry = record(raw);
        const path = string(entry?.path);
        const mode = string(entry?.mode);
        const type = string(entry?.type);
        const entrySha = sha(entry?.sha);
        if (
          path === undefined ||
          !['100644', '100755', '120000', '160000', '040000'].includes(
            mode ?? '',
          ) ||
          !['blob', 'tree', 'commit'].includes(type ?? '') ||
          entrySha === undefined
        ) {
          fail();
        }
        return {
          path,
          mode: mode as GitTreeEntry['mode'],
          type: type as GitTreeEntry['type'],
          sha: entrySha,
        };
      });
      return { sha: responseSha, truncated: value.truncated, entries };
    },
    async createBlob(input) {
      const value = record(
        await request('POST', `${repo}/git/blobs`, {
          content: input.content,
          encoding: input.encoding,
        }),
      );
      const blobSha = sha(value?.sha);
      if (blobSha === undefined) fail();
      return { sha: blobSha };
    },
    async createTree(input) {
      const value = record(
        await request('POST', `${repo}/git/trees`, {
          base_tree: input.baseTree,
          tree: input.entries,
        }),
      );
      const treeSha = sha(value?.sha);
      if (treeSha === undefined) fail();
      return { sha: treeSha };
    },
    async createCommit(input) {
      const value = record(await request('POST', `${repo}/git/commits`, input));
      const commitSha = sha(value?.sha);
      if (commitSha === undefined) fail();
      return { sha: commitSha };
    },
    async createReference(input) {
      const value = record(await request('POST', `${repo}/git/refs`, input));
      const ref = string(value?.ref);
      const refSha = sha(record(value?.object)?.sha);
      if (ref === undefined || refSha === undefined) fail();
      return { ref, sha: refSha };
    },
    async listOpenPullRequests(input) {
      const query = new URLSearchParams({
        state: 'open',
        head: `${scope.owner}:${input.head}`,
        base: input.base,
        per_page: '10',
      });
      const value = await request('GET', `${repo}/pulls?${query.toString()}`);
      if (!Array.isArray(value)) fail();
      return value.map(parsePullRequest);
    },
    async createDraftPullRequest(input) {
      const value = await request('POST', `${repo}/pulls`, input);
      return parsePullRequest(value);
    },
  };
  return Object.freeze(client);
}

function createFactory(
  dependencies: FactoryDependencies,
): GitHubInstallationClientFactory {
  const now = dependencies.now ?? (() => new Date());
  return Object.freeze({
    async withClient<T>(
      scope: InstallationClientScope,
      operation: (client: GitHubInstallationClient) => Promise<T>,
    ): Promise<T> {
      let authentication: unknown;
      try {
        authentication = await dependencies.auth({
          type: 'installation',
          installationId: scope.installationId,
          repositoryIds: [...scope.repositoryIds],
          permissions: { contents: 'write', pull_requests: 'write' },
          refresh: true,
        });
      } catch {
        throw new GitHubPublisherError(
          'github_unavailable',
          'GitHub App installation authentication failed',
        );
      }
      const token = verifyAuthResult(authentication, scope, now());
      return operation(createClient(scope, token, dependencies.fetch));
    },
  });
}

export interface GitHubAppClientFactoryOptions {
  readonly appId: number;
  readonly privateKey: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createGitHubAppClientFactory(
  options: GitHubAppClientFactoryOptions,
): GitHubInstallationClientFactory {
  if (!Number.isSafeInteger(options.appId) || options.appId <= 0)
    throw new Error('GitHub App ID must be a positive safe integer');
  if (
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----\n[\s\S]+\n-----END (?:RSA )?PRIVATE KEY-----\n?$/.test(
      options.privateKey,
    )
  ) {
    throw new Error('GitHub App private key must be a PEM private key');
  }
  if ((options.apiBaseUrl ?? OFFICIAL_API_BASE) !== OFFICIAL_API_BASE)
    throw new Error(
      'Only the official https://api.github.com API is supported',
    );
  const auth = createAppAuth({
    appId: options.appId,
    privateKey: options.privateKey,
  });
  return createFactory({
    auth: (input) => auth(input as InstallationAuthOptions),
    fetch: options.fetch ?? globalThis.fetch,
  });
}

export function createGitHubAppClientFactoryForTest(
  dependencies: FactoryDependencies,
): GitHubInstallationClientFactory {
  return createFactory(dependencies);
}
