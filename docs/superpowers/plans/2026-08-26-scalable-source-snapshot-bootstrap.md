# Scalable Source Snapshot Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Passerine's bounded source tree ingest quickly and fail visibly so the existing Agent OS feature run can reach specification approval.

> **Follow-up decision — 2026-08-26:** Add a separate 24 MiB Managed Agents
> access-file limit so the approved bounded source bundle can be mounted without
> raising the 1 MiB model-output limit. This overrides the Managed Agents entry
> in the do-not-modify list only for Task 4 below.

**Architecture:** Keep the single canonical `source-bundle-v1` artifact, but raise its shared bounded whole-repository policy to 16 MiB of decoded content and 24 MiB serialized. Preflight local blob sizes from `git ls-tree -l`, read validated blobs through one byte-parsed `git cat-file --batch` process, and record any stable source-ingestion failure on the durable source effect before rethrowing.

**Tech Stack:** TypeScript, Node.js child processes and Buffers, Git plumbing, Vitest, pnpm/Turbo, Next.js control plane, Trigger.dev local worker.

---

## File map

- Modify `packages/adapters/src/github/source-snapshot.ts:13-16,103-176` — export and enforce the shared 5,000-file, 1 MiB file, 16 MiB content, and 24 MiB bundle policy.
- Modify `packages/adapters/src/github/source-snapshot.test.ts:133-159` — prove the individual, aggregate, and serialized ceilings independently.
- Modify `packages/adapters/src/local-git/git.ts:14-41,158-234` — add narrowly allowlisted batch plumbing, one bounded byte-returning process runner, and a strict batch-protocol parser.
- Modify `packages/adapters/src/local-git/git.test.ts:5,44-151` — prove exact multi-blob batch reads and fail-closed protocol parsing.
- Modify `packages/adapters/src/local-git/source-snapshot.ts:9-14,31-35,61-78,145-198` — preflight sized tree entries, batch read once, strictly decode UTF-8, and preserve canonical bundle assembly.
- Modify `packages/adapters/src/local-git/source-snapshot.test.ts:1-5,38-205` — prove a source above the former aggregate limit succeeds and invalid UTF-8 remains rejected.
- Modify `packages/adapters/src/trigger/outbox.ts:30-35,255-289` — persist a bounded allowlisted source failure and stop before Trigger dispatch.
- Modify `packages/adapters/src/trigger/outbox.test.ts:194-338` — prove failure visibility, sanitization, reclaim, and exactly-once dispatch.
- Modify `docs/superpowers/specs/2026-08-26-scalable-source-snapshot-bootstrap-design.md:3-10` — retain the approved parser-test placement follow-up.
- Create `docs/superpowers/plans/2026-08-26-scalable-source-snapshot-bootstrap.md` — this executable plan.

## Do not modify

- `agentos/start-work-test.yaml` except to remove this temporary untracked live-test file after the run no longer needs it.
- Any user-facing "Setup" or "Start Work" copy; Agent OS itself owns that feature payload.
- `packages/adapters/src/artifacts/**`, Trigger task payloads, workflow state machines, application reconciliation, HTTP routes, database schemas, UI components, project import, or publication. Managed Agents files remain excluded except for the exact Task 4 limit split.
- The main checkout's unrelated `agentos/agent-os.yaml`.
- Provider credentials, `.env.local`, or the current run's budget/config snapshot.

### Task 1: Establish the shared bounded source policy

**Files:**
- Modify: `packages/adapters/src/github/source-snapshot.test.ts:133-159`
- Modify: `packages/adapters/src/github/source-snapshot.ts:13-16,103-176`

- [ ] **Step 1: Replace the ambiguous one-MiB tests with independent failing policy tests**

Keep the current individual-file test and replace the aggregate test with these cases:

```ts
it('accepts aggregate source content above one MiB and within sixteen MiB', async () => {
  const entries = ['one.ts', 'two.ts'].map((path) => ({
    path,
    mode: '100644' as const,
    type: 'blob' as const,
    sha: sha('c'),
  }));
  const { client, ingestor } = fixture(entries);
  const bytes = new TextEncoder().encode('x'.repeat(600_000));
  vi.mocked(client.getBlob).mockImplementation(async (blobSha) => ({
    sha: blobSha,
    size: bytes.byteLength,
    bytes,
  }));

  await expect(ingestor.ensure('run-1')).resolves.toMatchObject({
    sizeBytes: expect.any(Number),
  });
});

it('rejects aggregate source content beyond sixteen MiB', async () => {
  const entries = Array.from({ length: 17 }, (_, index) => ({
    path: `src/${String(index)}.ts`,
    mode: '100644' as const,
    type: 'blob' as const,
    sha: sha('c'),
  }));
  const { client, ingestor } = fixture(entries);
  const bytes = new TextEncoder().encode('x'.repeat(1_000_000));
  vi.mocked(client.getBlob).mockImplementation(async (blobSha) => ({
    sha: blobSha,
    size: bytes.byteLength,
    bytes,
  }));

  await expect(ingestor.ensure('run-1')).rejects.toThrow('total size limit');
});

it('rejects a canonical bundle beyond twenty-four MiB', async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    path: `src/${String(index)}.txt`,
    mode: '100644' as const,
    type: 'blob' as const,
    sha: sha('c'),
  }));
  const { client, ingestor } = fixture(entries);
  const bytes = new TextEncoder().encode('\u0001'.repeat(900_000));
  vi.mocked(client.getBlob).mockImplementation(async (blobSha) => ({
    sha: blobSha,
    size: bytes.byteLength,
    bytes,
  }));

  await expect(ingestor.ensure('run-1')).rejects.toThrow(
    'managed resource size limit',
  );
});
```

- [ ] **Step 2: Run the GitHub snapshot test and observe RED**

Run:

```bash
pnpm --filter @agentos/adapters exec vitest run src/github/source-snapshot.test.ts
```

Expected: the 1.2 MiB aggregate case fails with `source snapshot exceeds total size limit`; the sixteen-MiB boundary is not implemented.

- [ ] **Step 3: Export and apply the explicit shared constants**

Replace the four private/old constants with:

```ts
export const MAX_SOURCE_FILES = 5_000;
export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
export const MAX_SOURCE_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_SOURCE_BUNDLE_BYTES = 24 * 1024 * 1024;
```

Use `MAX_SOURCE_FILES`, `MAX_SOURCE_FILE_BYTES`, and
`MAX_SOURCE_TOTAL_BYTES` in the existing tree, per-blob, and running-total
guards. Keep `MAX_SOURCE_BUNDLE_BYTES` on the canonical JSON byte array. Do not
change any error text or GitHub API ordering.

- [ ] **Step 4: Run the GitHub snapshot test and observe GREEN**

Run:

```bash
pnpm --filter @agentos/adapters exec vitest run src/github/source-snapshot.test.ts
```

Expected: all GitHub source-snapshot tests pass, including the unchanged
1 MiB individual-file rejection, 1.2 MiB acceptance, 17 MiB aggregate
rejection, and escaped 24 MiB bundle rejection.

- [ ] **Step 5: Commit the shared policy slice**

```bash
git add packages/adapters/src/github/source-snapshot.ts packages/adapters/src/github/source-snapshot.test.ts
git commit -m "fix(adapters): bound ordinary source snapshots"
```

### Task 2: Batch local Git blob ingestion

**Files:**
- Modify: `packages/adapters/src/local-git/git.test.ts:5,44-151`
- Modify: `packages/adapters/src/local-git/source-snapshot.test.ts:1-5,38-205`
- Modify: `packages/adapters/src/local-git/git.ts:14-41,158-234`
- Modify: `packages/adapters/src/local-git/source-snapshot.ts:9-14,31-35,61-78,145-198`

- [ ] **Step 1: Add failing batch-reader protocol tests**

Import `parseGitBlobBatch` and `readGitBlobs` from `./git.js`, then add:

```ts
describe('readGitBlobs', () => {
  it('reads multiple blobs byte-exactly in one batch', async () => {
    const root = await fixtureRoot();
    const repo = await seedRepo(root, 'exp');
    const first = await runGit(repo, ['rev-parse', 'HEAD:file.txt']);
    const second = await runGit(repo, ['hash-object', '-w', '--stdin'], {
      input: 'second blob\n\n',
    });

    const blobs = await readGitBlobs(repo, [first, second]);

    expect(blobs.map((blob) => new TextDecoder().decode(blob))).toEqual([
      'hello\n',
      'second blob\n\n',
    ]);
  });

  it.each([
    ['malformed header', Buffer.from('not-a-header\n')],
    [
      'mismatched object',
      Buffer.from(`${'b'.repeat(40)} blob 1\nx\n`),
    ],
    [
      'wrong object type',
      Buffer.from(`${'a'.repeat(40)} tree 1\nx\n`),
    ],
    [
      'truncated body',
      Buffer.from(`${'a'.repeat(40)} blob 2\nx\n`),
    ],
    [
      'invalid delimiter',
      Buffer.from(`${'a'.repeat(40)} blob 1\nxx`),
    ],
    [
      'trailing output',
      Buffer.from(`${'a'.repeat(40)} blob 1\nx\nextra`),
    ],
  ])('rejects %s', (_label, output) => {
    expect(() => parseGitBlobBatch(output, ['a'.repeat(40)])).toThrow(
      /batch output/,
    );
  });
});
```

- [ ] **Step 2: Add failing local aggregate and UTF-8 tests**

Add a repository containing two 600,000-byte text files, commit it, and assert
that `ensure()` succeeds with `metadata.sizeBytes > 1024 * 1024`. Add a second
repository containing `Buffer.from([0xc3, 0x28])`, commit it, and assert that
`ensure()` rejects with `/binary/`. Use the existing `fixtureRoot`, `seedRepo`,
`writeFile`, `exec`, and `ingestorFor` helpers; resolve the pinned SHA only after
committing the new files.

```ts
it('ingests aggregate local text above one MiB within the bounded total', async () => {
  const root = await fixtureRoot();
  const repo = await seedRepo(root, 'exp');
  await writeFile(join(repo, 'one.txt'), 'x'.repeat(600_000));
  await writeFile(join(repo, 'two.txt'), 'y'.repeat(600_000));
  await exec('git', ['-C', repo, 'add', 'one.txt', 'two.txt']);
  await exec('git', ['-C', repo, 'commit', '-m', 'add ordinary source']);
  const headSha = (
    await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  const { ingestor } = ingestorFor(root, {
    'run-1': {
      projectId: 'project-1',
      localPath: repo,
      baseBranch: 'main',
      repositorySha: headSha,
    },
  });

  await expect(ingestor.ensure('run-1')).resolves.toMatchObject({
    sizeBytes: expect.any(Number),
  });
  expect((await ingestor.ensure('run-1')).sizeBytes).toBeGreaterThan(
    1024 * 1024,
  );
});

it('rejects invalid UTF-8 without relying on a NUL byte', async () => {
  const root = await fixtureRoot();
  const repo = await seedRepo(root, 'exp');
  await writeFile(join(repo, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await exec('git', ['-C', repo, 'add', 'invalid.txt']);
  await exec('git', ['-C', repo, 'commit', '-m', 'add invalid utf8']);
  const headSha = (
    await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  const { ingestor } = ingestorFor(root, {
    'run-1': {
      projectId: 'project-1',
      localPath: repo,
      baseBranch: 'main',
      repositorySha: headSha,
    },
  });

  await expect(ingestor.ensure('run-1')).rejects.toThrow(/binary/);
});
```

- [ ] **Step 3: Run both local tests and observe RED**

Run:

```bash
pnpm --filter @agentos/adapters exec vitest run src/local-git/git.test.ts src/local-git/source-snapshot.test.ts
```

Expected: compilation fails because `readGitBlobs` and `parseGitBlobBatch` do
not exist; without those imports the aggregate test fails at the old 1 MiB
limit and invalid UTF-8 is not rejected reliably.

- [ ] **Step 4: Implement the bounded byte runner and strict parser**

Add `-l` to `ls-tree` and `--batch` to `cat-file` in
`SUBCOMMAND_RULES`. Extract the existing spawn body into a private
`runGitBuffer()` that performs the same argument/env checks and returns a
`Buffer` under the existing 32 MiB output cap. Keep `runGit()` as the UTF-8
decode/optional-trim wrapper over that function.

Add this parser and fixed batch helper:

```ts
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_BATCH_OBJECTS = 5_000;

function malformedBatch(): never {
  throw new LocalGitError(
    'git_failed',
    'git cat-file batch output is malformed',
  );
}

export function parseGitBlobBatch(
  raw: Uint8Array,
  expectedObjectIds: readonly string[],
): readonly Uint8Array[] {
  const output = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const expected of expectedObjectIds) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1 || newline - offset > 128) malformedBatch();
    const header = output.subarray(offset, newline).toString('ascii');
    const match = /^([0-9a-f]{40}) ([a-z-]+) ([0-9]+)$/.exec(header);
    if (match === null) malformedBatch();
    const [, objectId, type, sizeText] = match;
    const size = Number(sizeText);
    if (
      objectId !== expected ||
      type !== 'blob' ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      malformedBatch();
    const bodyStart = newline + 1;
    const bodyEnd = bodyStart + size;
    if (bodyEnd >= output.byteLength || output[bodyEnd] !== 0x0a)
      malformedBatch();
    blobs.push(output.subarray(bodyStart, bodyEnd));
    offset = bodyEnd + 1;
  }
  if (offset !== output.byteLength) malformedBatch();
  return blobs;
}

export async function readGitBlobs(
  repository: string,
  objectIds: readonly string[],
): Promise<readonly Uint8Array[]> {
  if (
    objectIds.length > MAX_BATCH_OBJECTS ||
    objectIds.some((objectId) => !SHA_PATTERN.test(objectId))
  )
    throw new LocalGitError(
      'forbidden_argument',
      'git batch object list is invalid',
    );
  if (objectIds.length === 0) return [];
  const output = await runGitBuffer(repository, ['cat-file', '--batch'], {
    input: `${objectIds.join('\n')}\n`,
  });
  return parseGitBlobBatch(output, objectIds);
}
```

The actual `runGitBuffer()` implementation must install the existing EPIPE
handler, collect at most 16 KiB of stderr, kill on output overflow, reject Git
spawn/nonzero errors with `LocalGitError`, and settle the promise only once.

- [ ] **Step 5: Preflight sized tree entries and assemble from one batch**

Import all four shared constants and `readGitBlobs`. Change the tree command to
`['ls-tree', '-r', '-l', '-z', treeSha]`. Parse the fourth header token as a
safe integer size for blobs. After sorting, validate duplicates, per-file size,
and the running total before reading content:

```ts
const sortedEntries = [...entries].sort((left, right) =>
  left.path.localeCompare(right.path),
);
const seen = new Set<string>();
let totalBytes = 0;
for (const entry of sortedEntries) {
  if (seen.has(entry.path))
    throw new Error('source snapshot contains duplicate paths');
  seen.add(entry.path);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0)
    throw new Error('source snapshot tree entry is malformed');
  if (entry.size > MAX_SOURCE_FILE_BYTES)
    throw new Error('source snapshot file exceeds size limit');
  totalBytes += entry.size;
  if (totalBytes > MAX_SOURCE_TOTAL_BYTES)
    throw new Error('source snapshot exceeds total size limit');
}

const blobs = await readGitBlobs(
  repo,
  sortedEntries.map((entry) => entry.sha),
);
const files = sortedEntries.map((entry, index) => {
  const blob = blobs[index];
  if (blob === undefined || blob.byteLength !== entry.size)
    throw new Error('source snapshot batch blob size mismatch');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(blob);
  } catch {
    throw new Error('source snapshot contains a binary file');
  }
  if (content.includes('\0'))
    throw new Error('source snapshot contains a binary file');
  return {
    path: entry.path,
    mode: entry.mode as '100644' | '100755',
    content,
  };
});
```

Build and store the same canonical body. Do not change repository identity,
artifact scope/key/version/media type, or content ordering.

- [ ] **Step 6: Run local tests and observe GREEN**

Run:

```bash
pnpm --filter @agentos/adapters exec vitest run src/local-git/git.test.ts src/local-git/source-snapshot.test.ts
```

Expected: all batch protocol, aggregate source, strict UTF-8, containment,
symlink, NUL, exact trailing-byte, idempotency, and plumbing allowlist tests
pass.

- [ ] **Step 7: Commit the local batch slice**

```bash
git add packages/adapters/src/local-git/git.ts packages/adapters/src/local-git/git.test.ts packages/adapters/src/local-git/source-snapshot.ts packages/adapters/src/local-git/source-snapshot.test.ts
git commit -m "perf(adapters): batch local source ingestion"
```

### Task 3: Record source-ingestion failures durably

**Files:**
- Modify: `packages/adapters/src/trigger/outbox.test.ts:194-338`
- Modify: `packages/adapters/src/trigger/outbox.ts:30-35,255-289`

- [ ] **Step 1: Add the failing source-effect failure and retry test**

Add this start-suite test:

```ts
it('records a safe source failure and retries before one Trigger start', async () => {
  const checkpoints = new InMemoryWorkflowCheckpointStore();
  let attempts = 0;
  const ensure = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1)
      throw new Error('source snapshot exceeds total size limit');
    return {
      key: 'source/bundle-v1',
      digest: 'b'.repeat(64),
      sizeBytes: 123,
    };
  });
  const startFeature = vi.fn(async () => ({
    externalRunRef: 'trigger-run-1',
  }));
  const outbox = createDurableTriggerOutbox({
    checkpoints,
    trigger: {
      startFeature,
      startGoal: vi.fn(),
      retrieve: vi.fn(),
      cancel: vi.fn(),
    },
    approval: { create: vi.fn(), wait: vi.fn(), wake: vi.fn() },
    sourceSnapshot: { ensure },
    repository: repositoryWithRun('run-1'),
    clock: () => now,
  });
  const request = {
    idempotencyKey: 'workflow-start:run-1',
    runId: 'run-1',
    pipeline: 'feature' as const,
  };

  await expect(outbox.requestStart(request)).rejects.toThrow('total size');
  await expect(checkpoints.getEffect('source:run-1')).resolves.toMatchObject({
    status: 'failed',
    error: 'source snapshot exceeds total size limit',
  });
  expect(startFeature).not.toHaveBeenCalled();

  await expect(outbox.requestStart(request)).resolves.toBeUndefined();
  await expect(checkpoints.getEffect('source:run-1')).resolves.toMatchObject({
    status: 'succeeded',
    externalRef: 'source/bundle-v1',
  });
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(startFeature).toHaveBeenCalledTimes(1);
});
```

Add a second case whose ingestor throws
`new Error('provider failed token=must-not-persist')`; assert the stored error is
exactly `source snapshot ingestion failed` and does not contain `token`.

- [ ] **Step 2: Run the outbox test and observe RED**

Run:

```bash
pnpm --filter @agentos/adapters exec vitest run src/trigger/outbox.test.ts
```

Expected: the source effect remains `started` after the first exception rather
than becoming `failed`.

- [ ] **Step 3: Add allowlisted diagnostic normalization and fail the claimed effect**

Define the stable messages the two source adapters currently emit and a closed
normalizer:

```ts
const SOURCE_SNAPSHOT_FAILURES = new Set([
  'source snapshot binding run mismatch',
  'source snapshot binding SHA is malformed',
  'source snapshot repository binding mismatch',
  'source snapshot base SHA is stale',
  'source snapshot commit binding mismatch',
  'source snapshot tree is truncated',
  'source snapshot tree exceeds entry limit',
  'source snapshot tree entry is malformed',
  'source snapshot contains an unsafe path',
  'source snapshot contains unsupported submodule configuration',
  'source snapshot contains a symlink or submodule',
  'source snapshot contains a symlink, submodule, or unsupported tree entry',
  'source snapshot contains an unsupported tree entry',
  'source snapshot exceeds file limit',
  'source snapshot contains duplicate paths',
  'source snapshot file exceeds size limit',
  'source snapshot exceeds total size limit',
  'source snapshot contains a binary file',
  'source snapshot bundle exceeds managed resource size limit',
  'source snapshot pinned SHA not found in repository',
  'source snapshot pinned SHA is not a commit',
  'source snapshot pinned SHA does not resolve to itself',
  'source snapshot could not resolve a tree SHA',
  'source snapshot batch blob size mismatch',
]);

function safeSourceSnapshotFailure(error: unknown): string {
  return error instanceof Error && SOURCE_SNAPSHOT_FAILURES.has(error.message)
    ? error.message
    : 'source snapshot ingestion failed';
}
```

After `markEffectStarted`, wrap only ingestion, artifact attachment, and source
completion:

```ts
try {
  const source = await options.sourceSnapshot.ensure(request.runId);
  await options.checkpoints.attachExternalRef(
    sourceClaim.lease,
    source.key,
    options.clock(),
  );
  await options.checkpoints.completeEffect(
    sourceClaim.lease,
    {
      artifactKey: source.key,
      digest: source.digest,
      sizeBytes: source.sizeBytes,
    },
    options.clock(),
  );
} catch (error) {
  await options.checkpoints.failEffect(
    sourceClaim.lease,
    safeSourceSnapshotFailure(error),
    false,
    options.clock(),
  );
  throw error;
}
```

Leave workflow-start claiming below this block, guaranteeing Trigger is not
called after source failure.

- [ ] **Step 4: Run outbox tests and observe GREEN**

Run:

```bash
pnpm --filter @agentos/adapters exec vitest run src/trigger/outbox.test.ts
```

Expected: all outbox tests pass, including crash reconciliation, known failure
visibility, unknown-error sanitization, immediate same-owner reclaim, and one
Trigger start.

- [ ] **Step 5: Commit durable failure reporting**

```bash
git add packages/adapters/src/trigger/outbox.ts packages/adapters/src/trigger/outbox.test.ts
git commit -m "fix(adapters): surface source ingestion failures"
```

### Task 3a: Split Managed Agents access and output limits

**Files:**
- Modify `packages/adapters/src/managed-agents/types.ts`
- Modify `packages/adapters/src/managed-agents/provider.ts`
- Modify `packages/adapters/src/managed-agents/managed-agents.test.ts`

- [x] **Step 1: Prove mounted access files use an independent ceiling**

Add a focused test that configures `maxAccessFileBytes` above
`maxOutputBytes`, accepts a file at the access limit, and rejects one byte over
with an access-specific error. Also prove the default accepts a source payload
above the former 1 MiB ceiling.

```bash
pnpm --filter @agentos/adapters test -- managed-agents.test.ts
```

Expected: the new assertions fail because access files still use
`maxOutputBytes`.

- [x] **Step 2: Add the bounded access-file limit**

Add `maxAccessFileBytes` to `ManagedAgentsLimits` and `RequiredLimits`, default
it to the shared 24 MiB source-bundle ceiling, and use it only when validating
mounted files. Keep `maxOutputBytes` unchanged for collected model output.

```bash
pnpm --filter @agentos/adapters test -- managed-agents.test.ts
```

Expected: focused tests pass.

### Task 4: Verify the adapter and repository

**Files:**
- No production files.

- [ ] **Step 1: Run the complete adapter test suite**

```bash
pnpm --filter @agentos/adapters test
```

Expected: all adapter unit tests pass; configured integration-only tests may
remain skipped.

- [ ] **Step 2: Run repository typecheck and lint**

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit 0 in all packages.

- [ ] **Step 3: Run all repository tests**

```bash
pnpm test
```

Expected: all package tests pass; only configured integration tests are skipped.

- [ ] **Step 4: Run the production build with a safe public URL**

```bash
AGENTOS_PUBLIC_URL=https://control.example pnpm exec turbo run build --env-mode=loose
```

Expected: all packages and the control-plane production build exit 0 without
using or printing local credentials.

### Task 5: Resume the original Agent OS self-test

**Files:**
- No tracked production files.
- Remove after the live run no longer requires it: `agentos/start-work-test.yaml`

- [ ] **Step 1: Restart the local worker against the rebuilt adapter**

Stop the current Trigger worker session cleanly, rebuild `@agentos/core` and
`@agentos/adapters`, then restart Trigger with the existing worktree environment
and `--skip-update-check`. Do not pass credentials as command-line literals and
do not inspect process command lines.

```bash
pnpm turbo run build --filter=@agentos/core --filter=@agentos/adapters
pnpm exec trigger dev --skip-update-check
```

Expected: the worker registers the feature task and remains ready. The known
CLI/SDK version skew is reported separately if still present; do not mutate
dependencies during this bootstrap slice.

- [ ] **Step 2: Reconcile the original pending run**

Load `.env.local` into the shell without printing it, call the authenticated
local reconcile endpoint, and record only the JSON response and elapsed time:

```bash
set -a
source .env.local
set +a
curl --silent --show-error \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  http://localhost:3117/api/internal/workflows/reconcile
```

Expected: source ingestion for
`run_2df26fbce9c4315b4117b7936d5171cd` completes in a practical bounded interval
and the response no longer counts this source effect as failed. Never print the
authorization header or secret.

- [ ] **Step 3: Verify the human approval gate before further spend**

Open the local run page for
`run_2df26fbce9c4315b4117b7936d5171cd` on port 3117. Confirm that the source
effect is succeeded, the feature run has reached `waiting`, and its outstanding
approval is the specification approval for the visible "Setup" to "Start Work"
copy-only scope. Confirm no implementation role or publication has started.

- [ ] **Step 4: Hand the approval decision to the user**

Report the run status, ingestion duration, source artifact size, and exact
approval request. Do not approve on the user's behalf. Give the localhost run
link and wait for explicit approval before Agent OS spends the next model step.

- [ ] **Step 5: Keep the live-test state isolated**

Do not merge or push the bootstrap branch during the live trial. Keep the
worktree and servers available until the user has inspected the run. Once the
run and bootstrap change are explicitly accepted, remove the temporary config,
verify a clean tracked worktree, and use the repository's smoke-test → sign-off
→ rebase → push → stop → worktree-removal sequence.
