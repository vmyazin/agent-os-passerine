# Trusted GitHub Publisher

The publisher is the only Agent OS component allowed to create repository refs or pull requests. Agents and runtime sessions never receive GitHub installation credentials. They produce a versioned, full-file change manifest; a trusted control-plane authority signs the exact manifest, policy, configuration, source snapshot, base commit, and test evidence digests.

## GitHub App boundary

Install the GitHub App only on explicitly selected repositories. Its repository permissions are:

- Metadata: read (implicit GitHub App permission)
- Contents: read and write
- Pull requests: read and write

Do not grant Actions, Workflows, Administration, Secrets, Deployments, or organization permissions. The adapter mints a fresh installation token for each publication operation, narrows the request to one immutable repository ID, requests only `contents: write` and `pull_requests: write`, and verifies the effective token response before use. GitHub Enterprise Server and non-official API hosts are outside version-one scope.

The token exists only inside the adapter callback. It is not present in runtime DTOs, publication records, events, error messages, or return values. Raw GitHub clients, factories, scopes, stores, and test seams are package-internal. The package entry point exposes only the composite trusted publisher service with sanitized `publish`, `cancel`, and `status` operations. Its internal client has named Git Data and draft-PR methods; it has no generic request, ref-update, merge, deployment, or workflow method.

## Publication flow

1. Strictly parse the `publication-manifest-v1` envelope and recompute its canonical SHA-256 digest from UTF-8 full-file content.
2. Resolve the reviewed policy snapshot through a trusted control-plane resolver, recompute its canonical digest, require the manifest and authorization to bind that digest, and reject any attempt to remove default protected paths or relax hard binary, symlink, mode, count, or size limits.
3. Verify the rotating-key, purpose-bound publication authorization immediately before every GitHub write.
4. Read the selected repository, default branch ref, base commit, and complete recursive base tree from GitHub. The repository ID, owner/name, installation ID, default branch, and exact base SHA must match.
5. Reject protected or malformed paths, non-ASCII ambiguity, case collisions, file/directory shape conflicts, symlinks, submodules, special modes, binary content, missing modify/delete targets, and resolved-policy size/count limits for every add, modify, and delete.
6. Create immutable blobs, a tree with the exact base tree, and a deterministic commit with ownership trailers.
7. Re-read repository and base state immediately before creating the new `agentos/<sanitized-run>` ref. Never force-update an existing ref. Every phase before the durable PR checkpoint still requires the authorized base ref SHA, including orphan-ref recovery.
8. Bind a draft PR to the exact commit SHA, open state, title, body, head/base refs, and immutable head/base repository IDs. Re-read the ref after every PR response and immediately before its durable checkpoint. The publisher never merges or deploys.

## Recovery and cleanup

`publication_records` binds a project/run/repository to one policy and manifest digest. `agentos_claim_publication` serializes claims using an advisory transaction lock. `agentos_save_publication` atomically applies a compare-and-swap checkpoint and appends a sanitized event. Retries reconcile immutable Git objects, the owned ref, and the draft PR; foreign or stale collisions fail closed. Monotonic terminal cancellation is allowed before ref creation, after an owned ref, or after an owned PR; the record retains known commit and PR identifiers for later operator-approved cleanup. Cancellation is rechecked before PR mutation, after timeout reconciliation, before the PR checkpoint, and before success.

Blobs, trees, and commits created before a cancellation or crash are unreachable immutable Git objects. A ref created just before the authorized base advances is recorded as an owned orphan, but publication remains rejected on every retry and no PR is opened. The safe default is to leave immutable objects and owned orphan refs for explicit reconciliation or GitHub garbage collection. The publisher does not delete refs or close pull requests automatically and never deletes objects or refs it cannot prove it owns.

## Operational configuration

Keep the App private key and publication HMAC keys in the deployment secret manager. Rotate publication keys by issuing with one active key while retaining previous keys for verification until all outstanding authorizations expire. Selected repositories must be stored as immutable `(owner, name, installationId, repositoryId)` tuples in reviewed configuration.
