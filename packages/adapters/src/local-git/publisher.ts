import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  DEFAULT_PUBLICATION_POLICY,
  evaluatePublicationPolicy,
  isLocalRepository,
  parsePublicationManifest,
  validatePublicationAuthorization,
  type AttestationVerifier,
  type PublicationAuthorizationClaims,
  type PublicationChange,
  type PublicationManifestBody,
} from '@agentos/core';

import { collision, GitHubPublisherError, rejected } from '../github/errors.js';
import type {
  PublicationEvent,
  PublicationPhase,
  PublicationRecord,
  PublicationStore,
} from '../github/types.js';
import { assertContainedRepository, LocalGitError, runGit } from './git.js';

export interface LocalPublicationResult {
  readonly status: 'succeeded';
  readonly local: true;
  readonly branch: string;
  readonly commitSha: string;
  readonly repositoryUrl: string;
}

export interface LocalGitPublisherOptions {
  readonly workspacesRoot: string;
  readonly localPath: string;
  readonly verifier: AttestationVerifier<PublicationAuthorizationClaims>;
  readonly policy?: unknown;
  readonly store: PublicationStore;
  readonly now?: () => Date;
}

// Local git commits never have a "malformed ref" (like GitHub's API-returned
// shas) to validate against, but every sha we mint locally is still a
// 40-hex value -- keep the same shape check the GitHub publisher applies.
const GIT_SHA = /^[0-9a-f]{40}$/;

// This is the same phase sequence the GitHub publisher uses
// (packages/adapters/src/github/publisher.ts), reusing the *same*
// `PublicationPhase` union and the *same* `InMemoryPublicationStore`
// transition table (packages/adapters/src/github/store.ts, not editable by
// this task). That table only allows `succeeded` to be reached via
// `... -> ref_created -> pr_created -> succeeded`, so even though a local
// publish never creates a pull request, it still passes through the
// `pr_created` checkpoint as a no-op bridge -- there is no legal way to
// reach `succeeded` in the shared store without it. `commit_created` and
// `ref_created` map naturally onto "commit-tree ran" and "update-ref ran".
const LOCAL_PHASE_ORDER: Readonly<Record<PublicationPhase, number>> = {
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

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Local publication keys/binding keys are hashed with a `local-git-
 * publisher` tag as their first segment and the repository *name* (local
 * repositories have no numeric id) instead of a `repositoryId`. GitHub's
 * equivalents (packages/adapters/src/github/publisher.ts `publicationKey` /
 * `bindingKey`) never include that tag and always join a numeric
 * `repositoryId` in that position, so the two hash inputs are structurally
 * distinct strings -- collision between a GitHub key and a local key would
 * require a GitHub `projectId` to literally equal the string
 * `"local-git-publisher"`, which `idSchema` regex already permits as a
 * value but which no real caller can arrange to collide against a
 * *different* projectId/runId/digest tuple used for a real GitHub
 * publication. In short: distinguishable by construction, not by luck.
 */
function publicationKey(
  manifest: PublicationManifestBody,
  digest: string,
): string {
  if (!isLocalRepository(manifest.repository))
    rejected('GitHub publications must use the trusted GitHub publisher');
  return hash(
    [
      'local-git-publisher',
      manifest.projectId,
      manifest.runId,
      manifest.repository.name,
      manifest.policyDigest,
      digest,
    ].join('\0'),
  );
}

function bindingKey(manifest: PublicationManifestBody): string {
  if (!isLocalRepository(manifest.repository))
    rejected('GitHub publications must use the trusted GitHub publisher');
  return hash(
    ['local-git-publisher', manifest.projectId, manifest.runId].join('\0'),
  );
}

function branchForRun(runId: string, manifestDigest: string): string {
  return `agentos/${runId}-${manifestDigest.slice(0, 8)}`;
}

function commitMessage(runId: string): string {
  return `Agent OS: ${runId}`;
}

function phaseAtLeast(current: PublicationPhase, expected: PublicationPhase) {
  return LOCAL_PHASE_ORDER[current] >= LOCAL_PHASE_ORDER[expected];
}

function event(
  key: string,
  phase: PublicationPhase,
  at: string,
  details: PublicationEvent['details'] = {},
): PublicationEvent {
  return { publicationKey: key, phase, at, details };
}

function verifyAuthorization(
  parsed: ReturnType<typeof parsePublicationManifest>,
  verifier: AttestationVerifier<PublicationAuthorizationClaims>,
  at: Date,
): void {
  try {
    validatePublicationAuthorization(parsed, verifier, at, 'local-git-publisher');
  } catch {
    rejected('Publication authorization is invalid or expired');
  }
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

/** Parses one `git ls-tree -r -z` record: `<mode> <type> <sha>\t<path>`. */
function parseTreeEntries(raw: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const line of raw.split('\0')) {
    if (line.length === 0) continue;
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1)
      throw new GitHubPublisherError(
        'publication_rejected',
        'Repository tree entry is malformed',
      );
    const header = line.slice(0, tabIndex).split(' ');
    const [mode, type, sha] = header;
    if (mode === undefined || type === undefined || sha === undefined)
      throw new GitHubPublisherError(
        'publication_rejected',
        'Repository tree entry is malformed',
      );
    entries.set(line.slice(tabIndex + 1), { mode, type, sha });
  }
  return entries;
}

function applyChanges(
  entries: Map<string, TreeEntry>,
  changes: readonly PublicationChange[],
  blobShas: Readonly<Record<string, string>>,
): Map<string, TreeEntry> {
  const next = new Map(entries);
  for (const change of changes) {
    if (change.operation === 'delete') {
      if (!next.has(change.path))
        rejected(`Change target does not exist: ${change.path}`);
      next.delete(change.path);
      continue;
    }
    if (change.operation === 'add') {
      if (next.has(change.path))
        rejected(`Add target already exists: ${change.path}`);
    } else if (!next.has(change.path)) {
      rejected(`Change target does not exist: ${change.path}`);
    }
    const sha = blobShas[change.path];
    if (sha === undefined)
      throw new GitHubPublisherError(
        'publication_store_conflict',
        'Blob checkpoint is missing a written change',
      );
    next.set(change.path, { mode: change.mode, type: 'blob', sha });
  }
  return next;
}

interface DirNode {
  readonly files: Map<string, TreeEntry>;
  readonly dirs: Map<string, DirNode>;
}

function buildDirTree(entries: Map<string, TreeEntry>): DirNode {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of entries) {
    const parts = path.split('/');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]!;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  return root;
}

/**
 * Writes a `git mktree` tree object bottom-up: `mktree` only accepts one
 * directory's worth of entries per invocation, so subdirectories are
 * recursed into first (post-order) and their resulting tree shas are
 * substituted into the parent directory's `mktree` input.
 */
async function writeTree(repo: string, node: DirNode): Promise<string> {
  const lines: string[] = [];
  for (const [name, child] of node.dirs) {
    const childSha = await writeTree(repo, child);
    lines.push(`040000 tree ${childSha}\t${name}`);
  }
  for (const [name, file] of node.files) {
    lines.push(`${file.mode} ${file.type} ${file.sha}\t${name}`);
  }
  const input = lines.map((line) => `${line}\0`).join('');
  const sha = await runGit(repo, ['mktree', '-z'], { input });
  if (!GIT_SHA.test(sha))
    throw new GitHubPublisherError(
      'publication_rejected',
      'git returned a malformed tree SHA',
    );
  return sha;
}

const GIT_IDENTITY_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'Agent OS Publisher',
  GIT_AUTHOR_EMAIL: 'agentos@localhost',
  GIT_COMMITTER_NAME: 'Agent OS Publisher',
  GIT_COMMITTER_EMAIL: 'agentos@localhost',
});

export function createLocalGitPublisher(options: LocalGitPublisherOptions) {
  const now = options.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<LocalPublicationResult>>();

  const execute = async (input: unknown): Promise<LocalPublicationResult> => {
    const parsed = parsePublicationManifest(input);
    const manifest = parsed.manifest;
    if (!isLocalRepository(manifest.repository))
      rejected('GitHub publications must use the trusted GitHub publisher');

    verifyAuthorization(parsed, options.verifier, now());

    try {
      evaluatePublicationPolicy(
        manifest.changes,
        options.policy ?? DEFAULT_PUBLICATION_POLICY,
      );
    } catch (error) {
      if (error instanceof GitHubPublisherError) throw error;
      rejected(
        error instanceof Error
          ? error.message
          : 'Publication policy denied the requested changes',
      );
    }

    const key = publicationKey(manifest, parsed.manifestDigest);
    const branch = branchForRun(manifest.runId, parsed.manifestDigest);

    let record: PublicationRecord = await options.store.claim({
      key,
      bindingKey: bindingKey(manifest),
      projectId: manifest.projectId,
      runId: manifest.runId,
      // Local repositories have no numeric id; 0 is a stable sentinel that
      // never collides with a real (positive) GitHub repositoryId.
      repositoryId: 0,
      manifestDigest: parsed.manifestDigest,
      policyDigest: manifest.policyDigest,
      baseSha: manifest.expectedBase.sha,
      branch,
      now: now().toISOString(),
    });

    if (record.phase === 'succeeded') {
      if (record.commitSha === undefined || !GIT_SHA.test(record.commitSha))
        throw new GitHubPublisherError(
          'publication_store_conflict',
          'Completed publication record is malformed',
        );
      const repo = await assertContainedRepository(
        options.localPath,
        options.workspacesRoot,
      );
      return {
        status: 'succeeded',
        local: true,
        branch: record.branch,
        commitSha: record.commitSha,
        repositoryUrl: `file://${repo}`,
      };
    }

    const repo = await assertContainedRepository(
      options.localPath,
      options.workspacesRoot,
    );
    if (basename(repo) !== manifest.repository.name)
      rejected('Local repository name does not match the manifest');

    const base = await runGit(repo, ['rev-parse', manifest.expectedBase.branch]);
    if (base !== manifest.expectedBase.sha)
      rejected('Publication base changed');

    const baseEntries = parseTreeEntries(
      await runGit(repo, ['ls-tree', '-r', '-z', base]),
    );

    let blobShas: Record<string, string>;
    if (!phaseAtLeast(record.phase, 'blobs_created')) {
      blobShas = {};
      for (const change of manifest.changes) {
        if (change.operation === 'delete') continue;
        const sha = await runGit(repo, ['hash-object', '-w', '--stdin'], {
          input: change.content,
        });
        if (!GIT_SHA.test(sha))
          throw new GitHubPublisherError(
            'publication_rejected',
            'git returned a malformed blob SHA',
          );
        blobShas[change.path] = sha;
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
      blobShas = { ...(record.blobShas ?? {}) };
    }

    const newEntries = applyChanges(baseEntries, manifest.changes, blobShas);

    let newTree: string;
    if (!phaseAtLeast(record.phase, 'tree_created')) {
      newTree = await writeTree(repo, buildDirTree(newEntries));
      const treeAt = now().toISOString();
      record = await options.store.save(
        key,
        record.revision,
        { phase: 'tree_created', treeSha: newTree, updatedAt: treeAt },
        event(key, 'tree_created', treeAt, { treeSha: newTree }),
      );
    } else {
      if (record.treeSha === undefined || !GIT_SHA.test(record.treeSha))
        throw new GitHubPublisherError(
          'publication_store_conflict',
          'Durable tree checkpoint is missing',
        );
      newTree = record.treeSha;
    }

    let commitSha: string;
    if (!phaseAtLeast(record.phase, 'commit_created')) {
      commitSha = await runGit(
        repo,
        ['commit-tree', newTree, '-p', base, '-m', commitMessage(manifest.runId)],
        { env: GIT_IDENTITY_ENV },
      );
      if (!GIT_SHA.test(commitSha))
        throw new GitHubPublisherError(
          'publication_rejected',
          'git returned a malformed commit SHA',
        );
      const commitAt = now().toISOString();
      record = await options.store.save(
        key,
        record.revision,
        { phase: 'commit_created', commitSha, updatedAt: commitAt },
        event(key, 'commit_created', commitAt, { commitSha }),
      );
    } else {
      if (record.commitSha === undefined || !GIT_SHA.test(record.commitSha))
        throw new GitHubPublisherError(
          'publication_store_conflict',
          'Durable commit checkpoint is missing',
        );
      commitSha = record.commitSha;
    }

    if (!phaseAtLeast(record.phase, 'ref_created')) {
      try {
        await runGit(repo, [
          'update-ref',
          `refs/heads/${branch}`,
          commitSha,
          '',
        ]);
      } catch (error) {
        if (error instanceof LocalGitError)
          collision('Publication branch already exists');
        throw error;
      }
      const refAt = now().toISOString();
      record = await options.store.save(
        key,
        record.revision,
        { phase: 'ref_created', updatedAt: refAt },
        event(key, 'ref_created', refAt, { branch, commitSha }),
      );
    }

    // No pull request exists for a local publication; `pr_created` is used
    // purely as the required bridge phase between `ref_created` and
    // `succeeded` in the shared store's transition table (see the
    // `LOCAL_PHASE_ORDER` comment above).
    if (!phaseAtLeast(record.phase, 'pr_created')) {
      const prAt = now().toISOString();
      record = await options.store.save(
        key,
        record.revision,
        { phase: 'pr_created', updatedAt: prAt },
        event(key, 'pr_created', prAt),
      );
    }

    const succeededAt = now().toISOString();
    record = await options.store.save(
      key,
      record.revision,
      { phase: 'succeeded', commitSha, updatedAt: succeededAt },
      event(key, 'succeeded', succeededAt, { branch, commitSha }),
    );

    return {
      status: 'succeeded',
      local: true,
      branch,
      commitSha,
      repositoryUrl: `file://${repo}`,
    };
  };

  const publish = (input: unknown): Promise<LocalPublicationResult> => {
    const parsed = parsePublicationManifest(input);
    const key = publicationKey(parsed.manifest, parsed.manifestDigest);
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const promise = execute(input).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };

  return Object.freeze({ publish });
}
