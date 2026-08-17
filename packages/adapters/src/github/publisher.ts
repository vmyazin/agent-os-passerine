import { createHash } from 'node:crypto';

import {
  canonicalPublicationPolicyDigest,
  evaluatePublicationPolicy,
  normalizeRepositoryPathSyntax,
  normalizePublicationPolicySnapshot,
  parsePublicationManifest,
  validatePublicationAuthorization,
  type AttestationVerifier,
  type PublicationAuthorizationClaims,
  type PublicationChange,
  type PublicationManifestBody,
  type PublicationPolicySnapshot,
} from '@agentos/core';

import { collision, GitHubPublisherError, rejected } from './errors.js';
import type {
  GitHubInstallationClient,
  GitHubInstallationClientFactory,
  GitTreeEntry,
  InstallationClientScope,
  PublicationEvent,
  PublicationPhase,
  PublicationRecord,
  PublicationResult,
  PublicationStatusResult,
  PublicationStore,
  PullRequest,
} from './types.js';

const GIT_SHA = /^[0-9a-f]{40}$/;
const PHASE_ORDER: Readonly<Record<PublicationPhase, number>> = {
  failed: 0,
  claimed: 0,
  blobs_created: 1,
  tree_created: 2,
  commit_created: 3,
  ref_created: 4,
  pr_created: 5,
  succeeded: 6,
  cancelled: 7,
};

export interface TrustedGitHubPublisherOptions {
  readonly clients: GitHubInstallationClientFactory;
  readonly store: PublicationStore;
  readonly authorizationVerifier: AttestationVerifier<PublicationAuthorizationClaims>;
  readonly selectedRepositories: readonly PublicationManifestBody['repository'][];
  readonly policyResolver: (input: {
    readonly projectId: string;
    readonly runId: string;
    readonly configDigest: string;
    readonly policyDigest: string;
  }) => Promise<unknown>;
  readonly now?: () => Date;
  readonly isCancelled?: (projectId: string, runId: string) => Promise<boolean>;
  readonly beforeReference?: () => void | Promise<void>;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function branchForRun(runId: string): string {
  const slug = runId
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return `agentos/${slug || 'run'}-${hash(runId).slice(0, 8)}`;
}

function commitMessage(
  runId: string,
  manifestDigest: string,
  baseSha: string,
): string {
  return `Agent OS run ${runId}\n\nAgentOS-Run: ${runId}\nAgentOS-Manifest: ${manifestDigest}\nAgentOS-Base: ${baseSha}`;
}

function prMarker(
  runId: string,
  manifestDigest: string,
  baseSha: string,
): string {
  return `<!-- agentos:run=${runId};manifest=${manifestDigest};base=${baseSha} -->`;
}

function prTitle(runId: string): string {
  return `Agent OS: ${runId}`;
}

function prBody(marker: string): string {
  return `${marker}\n\nAutomated draft. Review and merge manually.`;
}

function publicationKey(
  manifest: PublicationManifestBody,
  digest: string,
): string {
  return hash(
    [
      manifest.projectId,
      manifest.runId,
      manifest.repository.repositoryId,
      manifest.policyDigest,
      digest,
    ].join('\0'),
  );
}

function bindingKey(manifest: PublicationManifestBody): string {
  return hash(
    [manifest.projectId, manifest.runId, manifest.repository.repositoryId].join(
      '\0',
    ),
  );
}

function sameRepository(
  left: PublicationManifestBody['repository'],
  right: PublicationManifestBody['repository'],
): boolean {
  return (
    left.owner.toLocaleLowerCase('en-US') ===
      right.owner.toLocaleLowerCase('en-US') &&
    left.name.toLocaleLowerCase('en-US') ===
      right.name.toLocaleLowerCase('en-US') &&
    left.installationId === right.installationId &&
    left.repositoryId === right.repositoryId
  );
}

function validateSha(value: string, label: string): string {
  if (!GIT_SHA.test(value)) rejected(`GitHub returned a malformed ${label}`);
  return value;
}

function phaseAtLeast(current: PublicationPhase, expected: PublicationPhase) {
  return PHASE_ORDER[current] >= PHASE_ORDER[expected];
}

function storedSha(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new GitHubPublisherError(
      'publication_store_conflict',
      `Durable ${label} checkpoint is missing`,
    );
  }
  return validateSha(value, label);
}

function storedBlobShas(
  value: Readonly<Record<string, string>> | undefined,
  changes: readonly PublicationChange[],
): Record<string, string> {
  const expected = changes
    .filter((change) => change.operation !== 'delete')
    .map((change) => change.path)
    .sort();
  const actual = value === undefined ? [] : Object.keys(value).sort();
  if (
    value === undefined ||
    expected.length !== actual.length ||
    expected.some((path, index) => path !== actual[index])
  ) {
    throw new GitHubPublisherError(
      'publication_store_conflict',
      'Durable blob checkpoint does not match the manifest',
    );
  }
  for (const shaValue of Object.values(value))
    validateSha(shaValue, 'blob SHA');
  return { ...value };
}

function validateRepository(
  actual: Awaited<ReturnType<GitHubInstallationClient['getRepository']>>,
  expected: PublicationManifestBody['repository'],
  expectedBranch: string,
): void {
  if (
    actual.id !== expected.repositoryId ||
    actual.fullName.toLocaleLowerCase('en-US') !==
      `${expected.owner}/${expected.name}`.toLocaleLowerCase('en-US') ||
    actual.defaultBranch !== expectedBranch
  ) {
    rejected('GitHub repository identity or default branch changed');
  }
}

function treeIndex(
  entries: readonly GitTreeEntry[],
): Map<string, GitTreeEntry> {
  const result = new Map<string, GitTreeEntry>();
  const folded = new Map<string, string>();
  for (const entry of entries) {
    const path = normalizeRepositoryPathSyntax(entry.path);
    const key = path.toLocaleLowerCase('en-US');
    const collisionPath = folded.get(key);
    if (collisionPath !== undefined)
      rejected('Repository contains a case-insensitive path collision');
    folded.set(key, path);
    result.set(key, entry);
  }
  return result;
}

function validateChangesAgainstTree(
  changes: readonly PublicationChange[],
  entries: readonly GitTreeEntry[],
  policy: PublicationPolicySnapshot,
): Map<string, GitTreeEntry> {
  const index = treeIndex(entries);
  for (const change of changes) {
    const parts = change.path.split('/');
    for (let indexPart = 1; indexPart < parts.length; indexPart += 1) {
      const ancestor = parts
        .slice(0, indexPart)
        .join('/')
        .toLocaleLowerCase('en-US');
      const ancestorEntry = index.get(ancestor);
      if (ancestorEntry !== undefined && ancestorEntry.type !== 'tree')
        rejected(`Change path crosses a repository file: ${change.path}`);
    }
    const existing = index.get(change.path.toLocaleLowerCase('en-US'));
    if (change.operation === 'add') {
      if (existing !== undefined)
        rejected(`Add target already exists: ${change.path}`);
      continue;
    }
    if (existing === undefined)
      rejected(`Change target does not exist: ${change.path}`);
    if (existing.path !== change.path)
      rejected(`Change target has a case-colliding path: ${change.path}`);
    if (
      existing.type !== 'blob' ||
      (existing.mode !== '100644' && existing.mode !== '100755')
    ) {
      rejected(`Change target is not a regular file: ${change.path}`);
    }
    if (
      change.operation === 'modify' &&
      !policy.allowedModes.includes(existing.mode)
    )
      rejected(`Existing file mode is denied by policy: ${change.path}`);
  }
  return index;
}

function ownedCommit(
  commit: Awaited<ReturnType<GitHubInstallationClient['getCommit']>>,
  expected: { message: string; treeSha: string; baseSha: string },
): boolean {
  return (
    commit.message === expected.message &&
    commit.treeSha === expected.treeSha &&
    commit.parents.length === 1 &&
    commit.parents[0] === expected.baseSha
  );
}

function ownedPullRequest(
  pullRequest: PullRequest,
  expected: {
    branch: string;
    base: string;
    baseSha: string;
    repositoryId: number;
    commitSha: string;
    title: string;
    body: string;
    marker: string;
  },
): boolean {
  return (
    pullRequest.draft === true &&
    pullRequest.state === 'open' &&
    pullRequest.title === expected.title &&
    pullRequest.head === expected.branch &&
    pullRequest.headSha === expected.commitSha &&
    pullRequest.base === expected.base &&
    pullRequest.baseSha === expected.baseSha &&
    pullRequest.headRepositoryId === expected.repositoryId &&
    pullRequest.baseRepositoryId === expected.repositoryId &&
    pullRequest.body === expected.body &&
    pullRequest.body.startsWith(expected.marker)
  );
}

function event(
  key: string,
  phase: PublicationEvent['phase'],
  at: string,
  details: PublicationEvent['details'] = {},
): PublicationEvent {
  return { publicationKey: key, phase, at, details };
}

function redactedStatus(
  record: PublicationRecord | undefined,
): PublicationStatusResult {
  if (record === undefined) return { status: 'not_found' };
  return {
    status: record.phase,
    branch: record.branch,
    ...(record.commitSha === undefined ? {} : { commitSha: record.commitSha }),
    ...(record.pullRequestNumber === undefined
      ? {}
      : { pullRequestNumber: record.pullRequestNumber }),
    ...(record.pullRequestUrl === undefined
      ? {}
      : { pullRequestUrl: record.pullRequestUrl }),
    ...(record.draft === true ? { draft: true as const } : {}),
  };
}

function verifyAuthorization(
  parsed: ReturnType<typeof parsePublicationManifest>,
  verifier: AttestationVerifier<PublicationAuthorizationClaims>,
  at: Date,
): void {
  try {
    validatePublicationAuthorization(parsed, verifier, at);
  } catch {
    rejected('Publication authorization is invalid or expired');
  }
}

export function createTrustedGitHubPublisher(
  options: TrustedGitHubPublisherOptions,
) {
  const now = options.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<PublicationResult>>();

  const prepare = async (input: unknown) => {
    const parsed = parsePublicationManifest(input);
    const manifest = parsed.manifest;
    const selected = options.selectedRepositories.some((candidate) =>
      sameRepository(candidate, manifest.repository),
    );
    if (!selected) rejected('Repository is not selected for publication');
    verifyAuthorization(parsed, options.authorizationVerifier, now());
    let policy: PublicationPolicySnapshot;
    try {
      policy = normalizePublicationPolicySnapshot(
        await options.policyResolver({
          projectId: manifest.projectId,
          runId: manifest.runId,
          configDigest: manifest.configDigest,
          policyDigest: manifest.policyDigest,
        }),
      );
      if (canonicalPublicationPolicyDigest(policy) !== manifest.policyDigest)
        rejected('Resolved publication policy digest does not match');
      evaluatePublicationPolicy(manifest.changes, policy);
    } catch (error) {
      if (error instanceof GitHubPublisherError) throw error;
      rejected('Resolved publication policy is invalid');
    }
    return { parsed, manifest, policy };
  };

  const branchFor = (input: unknown): string => {
    const parsed = parsePublicationManifest(input);
    return branchForRun(parsed.manifest.runId);
  };

  const execute = async (input: unknown): Promise<PublicationResult> => {
    const { parsed, manifest, policy } = await prepare(input);

    const key = publicationKey(manifest, parsed.manifestDigest);
    const branch = branchForRun(manifest.runId);
    let record = await options.store.claim({
      key,
      bindingKey: bindingKey(manifest),
      projectId: manifest.projectId,
      runId: manifest.runId,
      repositoryId: manifest.repository.repositoryId,
      manifestDigest: parsed.manifestDigest,
      policyDigest: manifest.policyDigest,
      baseSha: manifest.expectedBase.sha,
      branch,
      now: now().toISOString(),
    });
    if (record.phase === 'cancelled')
      throw new GitHubPublisherError(
        'publication_cancelled',
        'Publication was cancelled',
      );

    const cancelIfRequested = async (
      pullRequest?: PullRequest,
    ): Promise<void> => {
      const current = await options.store.get(key);
      if (current?.phase === 'cancelled') {
        if (pullRequest !== undefined) {
          if (
            current.pullRequestNumber !== undefined &&
            (current.pullRequestNumber !== pullRequest.number ||
              current.pullRequestUrl !== pullRequest.url ||
              current.draft !== true)
          )
            collision('Cancelled publication PR binding changed');
          if (current.pullRequestNumber === undefined) {
            const reconciledAt = now().toISOString();
            record = await options.store.save(
              key,
              current.revision,
              {
                phase: 'cancelled',
                pullRequestNumber: pullRequest.number,
                pullRequestUrl: pullRequest.url,
                draft: true,
                updatedAt: reconciledAt,
              },
              event(key, 'cancelled', reconciledAt, {
                pullRequestNumber: pullRequest.number,
                draft: true,
                reconciled: true,
              }),
            );
          }
        }
        throw new GitHubPublisherError(
          'publication_cancelled',
          'Publication was cancelled',
        );
      }
      if (!(await options.isCancelled?.(manifest.projectId, manifest.runId)))
        return;
      if (current?.phase === 'succeeded')
        collision('Completed publication cannot be cancelled');
      record = current ?? record;
      const cancelledAt = now().toISOString();
      record = await options.store.save(
        key,
        record.revision,
        {
          phase: 'cancelled',
          ...(pullRequest === undefined
            ? {}
            : {
                pullRequestNumber: pullRequest.number,
                pullRequestUrl: pullRequest.url,
                draft: true as const,
              }),
          updatedAt: cancelledAt,
        },
        event(key, 'cancelled', cancelledAt, {
          branch,
          ...(record.commitSha === undefined
            ? {}
            : { commitSha: record.commitSha }),
          ...(pullRequest === undefined
            ? {}
            : { pullRequestNumber: pullRequest.number, draft: true }),
        }),
      );
      throw new GitHubPublisherError(
        'publication_cancelled',
        'Publication was cancelled',
      );
    };

    const scope: InstallationClientScope = {
      ...manifest.repository,
      repositoryIds: [manifest.repository.repositoryId],
      permissions: { contents: 'write', pullRequests: 'write' },
    };

    try {
      return await options.clients.withClient(scope, async (github) => {
        const repository = await github.getRepository();
        validateRepository(
          repository,
          manifest.repository,
          manifest.expectedBase.branch,
        );
        const baseRef = await github.getReference(manifest.expectedBase.branch);
        const baseIsExact = baseRef?.sha === manifest.expectedBase.sha;
        if (record.phase === 'succeeded') {
          if (
            record.treeSha === undefined ||
            record.commitSha === undefined ||
            record.pullRequestNumber === undefined ||
            record.pullRequestUrl === undefined ||
            record.draft !== true
          ) {
            throw new GitHubPublisherError(
              'publication_store_conflict',
              'Completed publication record is malformed',
            );
          }
          const message = commitMessage(
            manifest.runId,
            parsed.manifestDigest,
            manifest.expectedBase.sha,
          );
          const remoteRef = await github.getReference(branch);
          if (remoteRef?.sha !== record.commitSha)
            collision('Completed publication branch binding changed');
          const remoteCommit = await github.getCommit(record.commitSha);
          if (
            !ownedCommit(remoteCommit, {
              message,
              treeSha: record.treeSha,
              baseSha: manifest.expectedBase.sha,
            })
          )
            collision('Completed publication commit binding changed');
          const marker = prMarker(
            manifest.runId,
            parsed.manifestDigest,
            manifest.expectedBase.sha,
          );
          const title = prTitle(manifest.runId);
          const body = prBody(marker);
          const pullRequests = await github.listOpenPullRequests({
            head: branch,
            base: manifest.expectedBase.branch,
          });
          const refAfterPullRequest = await github.getReference(branch);
          if (
            refAfterPullRequest?.sha !== record.commitSha ||
            pullRequests.length !== 1 ||
            pullRequests[0]?.number !== record.pullRequestNumber ||
            pullRequests[0]?.url !== record.pullRequestUrl ||
            !ownedPullRequest(pullRequests[0], {
              branch,
              base: manifest.expectedBase.branch,
              baseSha: manifest.expectedBase.sha,
              repositoryId: manifest.repository.repositoryId,
              commitSha: record.commitSha,
              title,
              body,
              marker,
            })
          )
            collision('Completed draft pull request binding changed');
          return {
            status: 'succeeded',
            branch,
            commitSha: record.commitSha,
            pullRequestNumber: record.pullRequestNumber,
            pullRequestUrl: record.pullRequestUrl,
            draft: true,
          };
        }
        if (!phaseAtLeast(record.phase, 'pr_created') && !baseIsExact)
          rejected('Publication base SHA is stale');

        let existingEntries: Map<string, GitTreeEntry> | undefined;
        let baseTreeSha: string | undefined;
        if (!phaseAtLeast(record.phase, 'tree_created')) {
          const baseCommit = await github.getCommit(manifest.expectedBase.sha);
          baseTreeSha = validateSha(baseCommit.treeSha, 'base tree SHA');
          const baseTree = await github.getTree(baseTreeSha);
          if (baseTree.sha !== baseTreeSha)
            rejected('GitHub returned a mismatched base tree');
          if (baseTree.truncated)
            rejected('Repository tree response was truncated');
          existingEntries = validateChangesAgainstTree(
            manifest.changes,
            baseTree.entries,
            policy,
          );
        }

        let blobShas: Record<string, string>;
        if (!phaseAtLeast(record.phase, 'blobs_created')) {
          blobShas = {};
          for (const change of manifest.changes) {
            if (change.operation === 'delete') continue;
            verifyAuthorization(parsed, options.authorizationVerifier, now());
            const blob = await github.createBlob({
              content: change.content,
              encoding: 'utf-8',
            });
            blobShas[change.path] = validateSha(blob.sha, 'blob SHA');
          }
          const blobsAt = now().toISOString();
          record = await options.store.save(
            key,
            record.revision,
            { phase: 'blobs_created', blobShas, updatedAt: blobsAt },
            event(key, 'blobs_created', blobsAt, {
              count: Object.keys(blobShas).length,
            }),
          );
        } else {
          blobShas = storedBlobShas(record.blobShas, manifest.changes);
        }

        let treeSha: string;
        if (!phaseAtLeast(record.phase, 'tree_created')) {
          if (existingEntries === undefined || baseTreeSha === undefined)
            throw new GitHubPublisherError(
              'publication_store_conflict',
              'Base tree checkpoint is unavailable',
            );
          const entries = manifest.changes.map((change) => {
            if (change.operation === 'delete') {
              const existing = existingEntries.get(
                change.path.toLocaleLowerCase('en-US'),
              );
              if (existing === undefined) rejected('Delete target disappeared');
              return {
                path: change.path,
                mode: existing.mode as '100644' | '100755',
                type: 'blob' as const,
                sha: null,
              };
            }
            return {
              path: change.path,
              mode: change.mode,
              type: 'blob' as const,
              sha: blobShas[change.path]!,
            };
          });
          verifyAuthorization(parsed, options.authorizationVerifier, now());
          const createdTree = await github.createTree({
            baseTree: baseTreeSha,
            entries,
          });
          treeSha = validateSha(createdTree.sha, 'created tree SHA');
          const treeAt = now().toISOString();
          record = await options.store.save(
            key,
            record.revision,
            { phase: 'tree_created', treeSha, updatedAt: treeAt },
            event(key, 'tree_created', treeAt, { treeSha }),
          );
        } else {
          treeSha = storedSha(record.treeSha, 'tree SHA');
        }

        const message = commitMessage(
          manifest.runId,
          parsed.manifestDigest,
          manifest.expectedBase.sha,
        );
        const identity = {
          name: 'Agent OS Publisher',
          email: 'agentos-publisher@users.noreply.github.com',
          date: parsed.authorization.issuedAt,
        } as const;
        let commitSha: string;
        if (!phaseAtLeast(record.phase, 'commit_created')) {
          verifyAuthorization(parsed, options.authorizationVerifier, now());
          const createdCommit = await github.createCommit({
            message,
            tree: treeSha,
            parents: [manifest.expectedBase.sha],
            author: identity,
            committer: identity,
          });
          commitSha = validateSha(createdCommit.sha, 'created commit SHA');
          const commitAt = now().toISOString();
          record = await options.store.save(
            key,
            record.revision,
            { phase: 'commit_created', commitSha, updatedAt: commitAt },
            event(key, 'commit_created', commitAt, { commitSha }),
          );
        } else {
          commitSha = storedSha(record.commitSha, 'commit SHA');
        }

        if (!phaseAtLeast(record.phase, 'ref_created')) {
          await options.beforeReference?.();
          await cancelIfRequested();

          const beforeRefRepository = await github.getRepository();
          validateRepository(
            beforeRefRepository,
            manifest.repository,
            manifest.expectedBase.branch,
          );
          const beforeRefBase = await github.getReference(
            manifest.expectedBase.branch,
          );
          const existingRef = await github.getReference(branch);
          if (existingRef === undefined) {
            if (beforeRefBase?.sha !== manifest.expectedBase.sha)
              rejected('Publication base changed before reference creation');
            try {
              verifyAuthorization(parsed, options.authorizationVerifier, now());
              await github.createReference({
                ref: `refs/heads/${branch}`,
                sha: commitSha,
              });
            } catch (error) {
              const reconciled = await github.getReference(branch);
              if (reconciled === undefined) throw error;
              if (reconciled.sha !== commitSha)
                collision('Publication branch is owned by a different commit');
            }
          } else if (existingRef.sha !== commitSha) {
            collision('Publication branch is owned by a different commit');
          }

          const afterRefRepository = await github.getRepository();
          validateRepository(
            afterRefRepository,
            manifest.repository,
            manifest.expectedBase.branch,
          );
        }
        const afterRef = await github.getReference(branch);
        if (afterRef?.sha !== commitSha)
          collision('Publication branch binding changed');
        const remoteCommit = await github.getCommit(commitSha);
        if (
          !ownedCommit(remoteCommit, {
            message,
            treeSha,
            baseSha: manifest.expectedBase.sha,
          })
        )
          collision('Publication commit does not have the trusted binding');
        if (!phaseAtLeast(record.phase, 'ref_created')) {
          const refAt = now().toISOString();
          record = await options.store.save(
            key,
            record.revision,
            { phase: 'ref_created', commitSha, updatedAt: refAt },
            event(key, 'ref_created', refAt, { branch, commitSha }),
          );
        }
        if (!phaseAtLeast(record.phase, 'pr_created')) {
          const currentBase = await github.getReference(
            manifest.expectedBase.branch,
          );
          if (currentBase?.sha !== manifest.expectedBase.sha)
            rejected('Publication base changed after reference creation');
        }
        await cancelIfRequested();

        const marker = prMarker(
          manifest.runId,
          parsed.manifestDigest,
          manifest.expectedBase.sha,
        );
        const title = prTitle(manifest.runId);
        const body = prBody(marker);
        const pullRequests = await github.listOpenPullRequests({
          head: branch,
          base: manifest.expectedBase.branch,
        });
        if (pullRequests.length > 1)
          collision('Multiple pull requests claim the publication branch');
        let pullRequest = pullRequests[0];
        if (
          pullRequest === undefined &&
          phaseAtLeast(record.phase, 'pr_created')
        )
          collision('Durable pull request is no longer open');
        if (pullRequest === undefined) {
          const beforePrBase = await github.getReference(
            manifest.expectedBase.branch,
          );
          if (beforePrBase?.sha !== manifest.expectedBase.sha)
            rejected('Publication base changed before pull request creation');
          const beforePrRef = await github.getReference(branch);
          if (beforePrRef?.sha !== commitSha)
            collision(
              'Publication branch changed before pull request creation',
            );
          await cancelIfRequested();
          try {
            verifyAuthorization(parsed, options.authorizationVerifier, now());
            pullRequest = await github.createDraftPullRequest({
              title,
              head: branch,
              base: manifest.expectedBase.branch,
              body,
              draft: true,
            });
          } catch (error) {
            const reconciled = await github.listOpenPullRequests({
              head: branch,
              base: manifest.expectedBase.branch,
            });
            if (reconciled.length > 1)
              collision('Multiple pull requests claim the publication branch');
            pullRequest = reconciled.length === 1 ? reconciled[0] : undefined;
            if (pullRequest === undefined) throw error;
          }
        }
        if (!phaseAtLeast(record.phase, 'pr_created')) {
          const baseAfterPullRequest = await github.getReference(
            manifest.expectedBase.branch,
          );
          if (baseAfterPullRequest?.sha !== manifest.expectedBase.sha)
            rejected('Publication base changed after pull request response');
        }
        const refAfterPullRequest = await github.getReference(branch);
        if (refAfterPullRequest?.sha !== commitSha)
          collision('Publication branch changed after pull request response');
        if (
          !ownedPullRequest(pullRequest, {
            branch,
            base: manifest.expectedBase.branch,
            baseSha: manifest.expectedBase.sha,
            repositoryId: manifest.repository.repositoryId,
            commitSha,
            title,
            body,
            marker,
          })
        )
          collision('Pull request is not owned by this publication');
        await cancelIfRequested(pullRequest);
        if (phaseAtLeast(record.phase, 'pr_created')) {
          if (
            record.pullRequestNumber !== pullRequest.number ||
            record.pullRequestUrl !== pullRequest.url ||
            record.draft !== true
          )
            collision('Durable pull request binding changed');
        } else {
          await cancelIfRequested(pullRequest);
          const checkpointBase = await github.getReference(
            manifest.expectedBase.branch,
          );
          if (checkpointBase?.sha !== manifest.expectedBase.sha)
            rejected('Publication base changed before pull request checkpoint');
          const checkpointRef = await github.getReference(branch);
          if (checkpointRef?.sha !== commitSha)
            collision(
              'Publication branch changed before pull request checkpoint',
            );
          const prAt = now().toISOString();
          record = await options.store.save(
            key,
            record.revision,
            {
              phase: 'pr_created',
              pullRequestNumber: pullRequest.number,
              pullRequestUrl: pullRequest.url,
              draft: true,
              updatedAt: prAt,
            },
            event(key, 'pr_created', prAt, {
              pullRequestNumber: pullRequest.number,
              draft: true,
            }),
          );
        }
        await cancelIfRequested(pullRequest);
        const succeededAt = now().toISOString();
        record = await options.store.save(
          key,
          record.revision,
          { phase: 'succeeded', updatedAt: succeededAt },
          event(key, 'succeeded', succeededAt),
        );
        return {
          status: 'succeeded',
          branch,
          commitSha,
          pullRequestNumber: pullRequest.number,
          pullRequestUrl: pullRequest.url,
          draft: true,
        };
      });
    } catch (error) {
      if (error instanceof GitHubPublisherError) throw error;
      throw new GitHubPublisherError(
        'github_unavailable',
        'GitHub operation failed',
      );
    }
  };

  const publish = (input: unknown): Promise<PublicationResult> => {
    const parsed = parsePublicationManifest(input);
    const key = publicationKey(parsed.manifest, parsed.manifestDigest);
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const promise = execute(input).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };

  const status = async (input: unknown): Promise<PublicationStatusResult> => {
    const { parsed, manifest } = await prepare(input);
    return redactedStatus(
      await options.store.get(publicationKey(manifest, parsed.manifestDigest)),
    );
  };

  const cancel = async (input: unknown): Promise<PublicationStatusResult> => {
    const { parsed, manifest } = await prepare(input);
    const key = publicationKey(manifest, parsed.manifestDigest);
    const current = await options.store.get(key);
    if (current === undefined || current.phase === 'cancelled')
      return redactedStatus(current);
    if (current.phase === 'succeeded') return redactedStatus(current);
    const cancelledAt = now().toISOString();
    return redactedStatus(
      await options.store.save(
        key,
        current.revision,
        { phase: 'cancelled', updatedAt: cancelledAt },
        event(key, 'cancelled', cancelledAt, {
          branch: current.branch,
          ...(current.commitSha === undefined
            ? {}
            : { commitSha: current.commitSha }),
          ...(current.pullRequestNumber === undefined
            ? {}
            : { pullRequestNumber: current.pullRequestNumber }),
        }),
      ),
    );
  };

  return Object.freeze({ publish, cancel, status, branchFor });
}
