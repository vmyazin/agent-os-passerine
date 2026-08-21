# Frozen Acceptance Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A feature run cannot publish unless tests the implementer cannot edit have passed in the sealed sandbox, and waiting for the operator to review those files does not consume the 60-minute execution budget.

**Architecture:** Core owns path reservation and `sealChangeSet`. The feature-workflow DoD schema becomes v2 with a 1:1 criterion-to-file pairing. Trusted code overlays those files after the implementer's change set, writes `sealed-changes`, and appends `node --test test/acceptance/` to `exactTrustedCommand`. Approval TTL is 24 hours; execution `deadlineMs` starts at `consumedAt`.

**Tech Stack:** TypeScript 6, Zod 4, Vitest, existing feature-workflow / control-plane test harnesses. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-frozen-acceptance-dod-design.md`

## Global Constraints

- Do not modify `packages/core/src/dod.ts`, `dod.test.ts`, or `verification-policy.ts`.
- Do not add a test-author agent, specifier write/bash tools, auto-approve, red-phase session, `npm run dev`, or cross-attempt memory.
- Do not change goal-start command criteria, publication HMAC, GitHub/local publisher internals, task IDs, budget admission, session timeout, or `agentos/agent-os.yaml`.
- Acceptance runner stays the trusted-code suffix `node --test test/acceptance/` (same class as the baked-in `pnpm install --frozen-lockfile --ignore-scripts`).
- File comments at the top of new/changed TS/TSX files (`// packages/core/src/acceptance-tests.ts`). Not on JSON or Markdown.
- Slice 1 (tasks 1–6) before slice 2 (tasks 7–8). Task 9 is docs after both slices are green.

## File map

| Path | Role |
| --- | --- |
| Create `packages/core/src/acceptance-tests.ts` | Prefix check, 1:1 pairing, `sealChangeSet` |
| Create `packages/core/src/acceptance-tests.test.ts` | Core contract tests |
| Modify `packages/core/src/index.ts:1-14` | Export the new module |
| Modify `packages/adapters/src/trigger/schemas.ts:133-149` | `definition-of-done-v2` |
| Modify `packages/adapters/src/trigger/schemas.test.ts` | Parse/reject cases |
| Modify `packages/adapters/src/trigger/verifier.test.ts:50-55` | v2 fixture |
| Modify `packages/adapters/src/trigger/goal-verifier.seam.test.ts:81-86` | v2 fixture |
| Modify `packages/adapters/src/trigger/workflow.ts:1161-1234,1397-1604` | Seal, `sealed-changes`, post-consume deadline |
| Modify `packages/adapters/src/trigger/workflow.test.ts:212-221,526-527` | v2 fixture, timeout, sealed artifact |
| Modify `packages/adapters/src/trigger/types.ts:22-32` | `approvalTtlMs` |
| Modify `packages/adapters/src/trigger/production-handler.ts:232-239,732-736` | Command suffix; remap `sealed-changes` |
| Modify `packages/adapters/src/trigger/production-handler.test.ts:61-73` | Suffix assertion |
| Modify `agentos/passerine.yaml:24-44,89-139` | Specifier/implementer/reviewer prompts |
| Modify `apps/control-plane/src/ui/setup-template.ts` | Same prompt edits (generated mirror) |
| Modify `apps/control-plane/src/ui/setup-template-local.ts` | Same prompt edits |
| Modify `apps/control-plane/src/application/control-plane-service.ts:265-272,1610-1692` | Inbox summary includes test bodies |
| Modify `apps/control-plane/src/http/contracts.ts:304-321` | `acceptanceTests` on approval schema |
| Modify `apps/control-plane/src/ui/inbox-view.tsx:124-147` | Render test files |
| Modify `apps/control-plane/src/application/workflow-reconciliation.ts:34-63,214-240` | Wait vs execute clock |
| Modify `docs/architecture/durable-feature-workflow.md:18-40,110-120` | Execution path + limits |

## Do not modify

- `packages/core/src/dod.ts`, `packages/core/src/dod.test.ts`
- `packages/core/src/verification-policy.ts`
- `packages/adapters/src/github/**`, `packages/adapters/src/local-git/**`
- `FEATURE_WORKFLOW_TASK_ID`, `GOAL_WORKFLOW_TASK_ID`
- Budget admission SQL, session lease keys, Trigger queue names
- `agentos/agent-os.yaml`

Shared v2 DoD fixture used in every adapters test that currently embeds v1 (copy this object; do not add a new shared module):

```ts
const v2Dod = {
  version: 'definition-of-done-v2' as const,
  criteria: [
    {
      id: 'status-test',
      description: 'Status route test passes',
      verifier: 'test-report' as const,
    },
  ],
  acceptanceTests: [
    {
      path: 'test/acceptance/status-test.test.mjs',
      mode: '100644' as const,
      content:
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('status', () => { assert.ok(true); });\n",
    },
  ],
};
```

Use `tests` as the criterion id in verifier/goal-seam fixtures, with path `test/acceptance/tests.test.mjs`.

---

### Task 1: Core acceptance-test reservation and seal

**Files:**

- Create: `packages/core/src/acceptance-tests.ts`
- Create: `packages/core/src/acceptance-tests.test.ts`
- Modify: `packages/core/src/index.ts:14` (add `export * from './acceptance-tests.js';`)

**Interfaces:**

- Consumes: `normalizeRepositoryPathSyntax` from `packages/core/src/publication.ts:336`
- Produces: `ACCEPTANCE_TEST_PREFIX`, `isAcceptanceTestPath`, `acceptanceTestPathForCriterion`, `acceptanceTestsPairingError`, `AcceptancePathReservedError`, `AcceptanceTestFile`, `ChangeSetChange`, `sealChangeSet`

- [ ] **Step 1: Write the failing core tests**

```ts
// packages/core/src/acceptance-tests.test.ts
import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_TEST_PREFIX,
  AcceptancePathReservedError,
  acceptanceTestPathForCriterion,
  acceptanceTestsPairingError,
  isAcceptanceTestPath,
  sealChangeSet,
} from './acceptance-tests.js';

describe('acceptance test paths', () => {
  it('reserves the prefix case-insensitively', () => {
    expect(ACCEPTANCE_TEST_PREFIX).toBe('test/acceptance/');
    expect(isAcceptanceTestPath('test/acceptance/list-deep-copy.test.mjs')).toBe(
      true,
    );
    expect(isAcceptanceTestPath('TEST/ACCEPTANCE/x.test.mjs')).toBe(true);
    expect(isAcceptanceTestPath('test/todo-store.test.mjs')).toBe(false);
    expect(isAcceptanceTestPath('src/test/acceptance/x.test.mjs')).toBe(false);
  });

  it('pairs each criterion id to exactly one file', () => {
    expect(acceptanceTestPathForCriterion('list-deep-copy')).toBe(
      'test/acceptance/list-deep-copy.test.mjs',
    );
    expect(
      acceptanceTestsPairingError(['list-deep-copy'], [
        'test/acceptance/list-deep-copy.test.mjs',
      ]),
    ).toBeUndefined();
    expect(
      acceptanceTestsPairingError(['list-deep-copy'], [
        'test/acceptance/other.test.mjs',
      ]),
    ).toMatch(/pairing/);
    expect(
      acceptanceTestsPairingError(['a', 'b'], [
        'test/acceptance/a.test.mjs',
      ]),
    ).toMatch(/pairing/);
  });
});

describe('sealChangeSet', () => {
  const frozen = {
    path: 'test/acceptance/list-deep-copy.test.mjs',
    mode: '100644' as const,
    content: 'export {}\n',
  };

  it('rejects an implementer change under the reserved prefix', () => {
    expect(() =>
      sealChangeSet(
        [
          {
            operation: 'add',
            path: 'test/acceptance/list-deep-copy.test.mjs',
            mode: '100644',
            content: 'smuggled\n',
          },
        ],
        [frozen],
      ),
    ).toThrow(AcceptancePathReservedError);
  });

  it('overlays frozen files after the implementer changes', () => {
    const sealed = sealChangeSet(
      [
        {
          operation: 'add',
          path: 'src/todo-store.mjs',
          mode: '100644',
          content: 'export {}\n',
        },
      ],
      [frozen],
    );
    expect(sealed).toEqual([
      {
        operation: 'add',
        path: 'src/todo-store.mjs',
        mode: '100644',
        content: 'export {}\n',
      },
      {
        operation: 'add',
        path: frozen.path,
        mode: '100644',
        content: frozen.content,
      },
    ]);
  });

  it('uses modify when the source bundle already has the frozen path', () => {
    const sealed = sealChangeSet(
      [
        {
          operation: 'add',
          path: 'src/todo-store.mjs',
          mode: '100644',
          content: 'export {}\n',
        },
      ],
      [frozen],
      new Set([frozen.path]),
    );
    expect(sealed.at(-1)).toMatchObject({
      operation: 'modify',
      path: frozen.path,
      content: frozen.content,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentos/core test -- src/acceptance-tests.test.ts`

Expected: FAIL because `acceptance-tests.ts` does not exist.

- [ ] **Step 3: Implement the module**

```ts
// packages/core/src/acceptance-tests.ts
import { normalizeRepositoryPathSyntax } from './publication.js';

export const ACCEPTANCE_TEST_PREFIX = 'test/acceptance/';

export interface AcceptanceTestFile {
  readonly path: string;
  readonly mode: '100644';
  readonly content: string;
}

export type ChangeSetChange =
  | {
      readonly operation: 'add' | 'modify';
      readonly path: string;
      readonly mode: '100644' | '100755';
      readonly content: string;
    }
  | { readonly operation: 'delete'; readonly path: string };

export class AcceptancePathReservedError extends Error {
  readonly code = 'acceptance_path_reserved';
  constructor(readonly path: string) {
    super(`acceptance_path_reserved: ${path}`);
    this.name = 'AcceptancePathReservedError';
  }
}

function normalizedPath(path: string): string {
  return normalizeRepositoryPathSyntax(path).toLocaleLowerCase('en-US');
}

export function isAcceptanceTestPath(path: string): boolean {
  try {
    const normalized = normalizedPath(path);
    return (
      normalized === 'test/acceptance' ||
      normalized.startsWith(ACCEPTANCE_TEST_PREFIX)
    );
  } catch {
    return false;
  }
}

export function acceptanceTestPathForCriterion(id: string): string {
  return `${ACCEPTANCE_TEST_PREFIX}${id}.test.mjs`;
}

export function acceptanceTestsPairingError(
  criterionIds: readonly string[],
  paths: readonly string[],
): string | undefined {
  const expected = criterionIds.map(acceptanceTestPathForCriterion);
  if (expected.length !== paths.length) {
    return 'acceptance test pairing: criterion count must equal file count';
  }
  const remaining = new Set(paths.map((path) => normalizedPath(path)));
  for (const path of expected) {
    if (!remaining.delete(normalizedPath(path))) {
      return `acceptance test pairing: missing ${path}`;
    }
  }
  if (remaining.size > 0) {
    return `acceptance test pairing: unexpected ${[...remaining].join(', ')}`;
  }
  return undefined;
}

export function sealChangeSet(
  changes: readonly ChangeSetChange[],
  acceptanceTests: readonly AcceptanceTestFile[],
  sourcePaths: ReadonlySet<string> = new Set(),
): readonly ChangeSetChange[] {
  for (const change of changes) {
    if (isAcceptanceTestPath(change.path)) {
      throw new AcceptancePathReservedError(change.path);
    }
  }
  const overlay: ChangeSetChange[] = acceptanceTests.map((file) => {
    const path = normalizeRepositoryPathSyntax(file.path);
    const exists = [...sourcePaths].some(
      (candidate) => normalizedPath(candidate) === normalizedPath(path),
    );
    return {
      operation: exists ? 'modify' : 'add',
      path,
      mode: '100644',
      content: file.content,
    };
  });
  return [...changes, ...overlay];
}
```

Add `export * from './acceptance-tests.js';` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run core tests**

Run: `pnpm --filter @agentos/core test -- src/acceptance-tests.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/acceptance-tests.ts packages/core/src/acceptance-tests.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
Add reserved acceptance-test paths and change-set sealing.

EOF
)"
```

---

### Task 2: DoD schema v2

**Files:**

- Modify: `packages/adapters/src/trigger/schemas.ts:133-149`
- Modify: `packages/adapters/src/trigger/schemas.test.ts` (add a `definitionOfDoneSchema` describe)
- Modify: `packages/adapters/src/trigger/verifier.test.ts:50-55`
- Modify: `packages/adapters/src/trigger/goal-verifier.seam.test.ts:81-86`

**Interfaces:**

- Consumes: `acceptanceTestsPairingError`, `isAcceptanceTestPath` from Task 1; `PUBLICATION_MAX_FILE_BYTES`, `PUBLICATION_MAX_TOTAL_BYTES` from `@agentos/core`
- Produces: `definitionOfDoneSchema` accepts only `definition-of-done-v2` with paired `acceptanceTests`

- [ ] **Step 1: Write failing schema tests** at the bottom of `schemas.test.ts`

```ts
import { definitionOfDoneSchema } from './schemas.js';

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
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/schemas.test.ts`

Expected: FAIL — v1 still parses, pairing is unenforced.

- [ ] **Step 3: Replace `definitionOfDoneSchema` in `schemas.ts`**

Keep the existing `criteria` array. Add `acceptanceTests` and a `superRefine`:

```ts
import {
  PUBLICATION_MAX_FILE_BYTES,
  PUBLICATION_MAX_TOTAL_BYTES,
  acceptanceTestsPairingError,
  isAcceptanceTestPath,
} from '@agentos/core';

export const definitionOfDoneSchema = z
  .object({
    version: z.literal('definition-of-done-v2'),
    criteria: z
      .array(
        z
          .object({
            id: identifier,
            description: z.string().min(1).max(2_000),
            verifier: z.literal('test-report'),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    acceptanceTests: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1_024),
            mode: z.literal('100644'),
            content: z.string().min(1).max(PUBLICATION_MAX_FILE_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = value.acceptanceTests.reduce(
      (sum, file) => sum + Buffer.byteLength(file.content),
      0,
    );
    if (bytes > PUBLICATION_MAX_TOTAL_BYTES) {
      context.addIssue({
        code: 'custom',
        message: 'acceptance tests exceed aggregate size',
      });
    }
    for (const file of value.acceptanceTests) {
      if (!isAcceptanceTestPath(file.path) || file.content.includes('\0')) {
        context.addIssue({
          code: 'custom',
          path: ['acceptanceTests'],
          message: `invalid acceptance test path: ${file.path}`,
        });
      }
    }
    const pairing = acceptanceTestsPairingError(
      value.criteria.map((criterion) => criterion.id),
      value.acceptanceTests.map((file) => file.path),
    );
    if (pairing !== undefined) {
      context.addIssue({ code: 'custom', message: pairing });
    }
  });
```

Update `verifier.test.ts` and `goal-verifier.seam.test.ts` fixtures from v1 to v2 using the shared fixture shape (`id: 'tests'`, path `test/acceptance/tests.test.mjs`). Leave `workflow.test.ts` for Task 4 — it will fail until seal + fixture land together.

- [ ] **Step 4: Run schema and verifier tests**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/schemas.test.ts src/trigger/verifier.test.ts src/trigger/goal-verifier.seam.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/trigger/schemas.ts packages/adapters/src/trigger/schemas.test.ts packages/adapters/src/trigger/verifier.test.ts packages/adapters/src/trigger/goal-verifier.seam.test.ts
git commit -m "$(cat <<'EOF'
Require executable acceptance tests on the feature DoD.

EOF
)"
```

---

### Task 3: Sealed command suffix and `changes.json` remap

**Files:**

- Modify: `packages/adapters/src/trigger/production-handler.ts:232-239,732-736`
- Modify: `packages/adapters/src/trigger/production-handler.test.ts:61-73`

**Interfaces:**

- Consumes: none from Task 1
- Produces: `exactTrustedCommand` ends with `&& node --test test/acceptance/`; verification mounts `artifactId === 'sealed-changes'` at `/workspace/inputs/changes.json`

- [ ] **Step 1: Extend the existing command test**

In `production-handler.test.ts`, after the current assertions:

```ts
expect(command).toContain("'pnpm' 'test' && node --test test/acceptance/");
expect(command.indexOf("'pnpm' 'test'")).toBeLessThan(
  command.indexOf('node --test test/acceptance/'),
);
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/production-handler.test.ts`

Expected: FAIL — suffix absent.

- [ ] **Step 3: Change `exactTrustedCommand` and the remap**

Replace the return in `exactTrustedCommand` (`production-handler.ts:239`) so the invocation is followed by the suffix:

```
return `set +e; IN=/workspace/inputs; [ -f "$IN/source-bundle.json" ] || IN=/mnt/session/uploads/workspace/inputs; rm -rf /workspace/repo; mkdir -p /workspace/repo; node "$IN/materialize.mjs" "$IN" && cd /workspace/repo && pnpm install --frozen-lockfile --ignore-scripts && ${invocation} && node --test test/acceptance/; code=$?; printf '\\nAGENTOS_EXIT_CODE=%s\\n' "$code"; exit "$code"`;
```

Do not change `MATERIALIZE_SCRIPT`. Change the remap at `:733-736` from `metadata.artifactId === 'changes'` to `metadata.artifactId === 'sealed-changes'`.

- [ ] **Step 4: Re-run**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/production-handler.test.ts src/trigger/goal-verifier.seam.test.ts`

Expected: PASS. Seam tests call `exactTrustedCommand`; their stored observation command string updates automatically.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/trigger/production-handler.ts packages/adapters/src/trigger/production-handler.test.ts
git commit -m "$(cat <<'EOF'
Run frozen acceptance tests after the project suite.

EOF
)"
```

---

### Task 4: Seal the change set in the feature workflow

**Files:**

- Modify: `packages/adapters/src/trigger/workflow.ts:1-41,1397-1604`
- Modify: `packages/adapters/src/trigger/workflow.test.ts:212-221` plus the happy-path assertions around `:545-549`

**Interfaces:**

- Consumes: `sealChangeSet`, `AcceptancePathReservedError` from Task 1; `definitionOfDoneSchema` v2 from Task 2; `changeSetSchema`
- Produces: in-memory sealed change set + `sealed-changes` artifact; verification and publication consume it; `changeSetDigest` binds the sealed set

- [ ] **Step 1: Update the workflow fixture to v2**

In `workflow.test.ts` fixture, replace the `dod` JSON with the v2 object (`id: 'status-test'`). Add a dedicated test (copy the happy-path workflow construction from `'runs separate least-privilege role sessions through trusted draft publication'`):

```ts
it('seals frozen acceptance tests onto the published change set', async () => {
  const f = await fixture();
  const authorized: Array<{ changeSet: unknown }> = [];
  await createDurableFeatureWorkflow({
    /* same deps as the happy-path test, with */
    publicationAuthority: {
      authorize: async (request) => {
        authorized.push({ changeSet: request.changeSet });
        return { authorized: request };
      },
    },
    publisher: {
      publish: async () => ({
        status: 'succeeded',
        draft: true,
        pullRequestUrl: 'https://github.test/pr/1',
      }),
    },
  }).run(input);
  expect(authorized[0]?.changeSet).toMatchObject({
    version: 'change-set-v1',
    changes: expect.arrayContaining([
      expect.objectContaining({
        path: 'src/status.ts',
      }),
      expect.objectContaining({
        path: 'test/acceptance/status-test.test.mjs',
        mode: '100644',
        content: expect.stringContaining('node:test'),
      }),
    ]),
  });
});

it('fails closed when the implementer touches test/acceptance/', async () => {
  const f = await fixture();
  await f.artifacts.put({
    scope: {
      projectId: 'project-1',
      runId: 'run-1',
      stepId: 'implementation',
    },
    artifactId: 'changes',
    version: 2,
    bytes: new TextEncoder().encode(
      JSON.stringify({
        version: 'change-set-v1',
        changes: [
          {
            operation: 'add',
            path: 'test/acceptance/status-test.test.mjs',
            mode: '100644',
            content: 'smuggled\n',
          },
        ],
      }),
    ),
    mediaType: 'application/json',
  });
  /* rebuild changeMeta by putting version 1 replacement — overwrite the fixture
     changes artifact before run() using the same put() helper as the fixture */
});
```

The reserved-path test is easier if the fixture's `put` helper overwrites: after `const f = await fixture()`, put a new `changes` artifact at `implementation/changes` with the reserved path (same version 1 key if the in-memory store replaces, or bump and also replace the runtime implementation-output metadata — that is fragile).

Simpler reserved-path test: unit-test already covers `sealChangeSet` in core. In workflow.test.ts, only assert the happy-path overlay and that verification `stepInput.changeSetArtifact.artifactId === 'sealed-changes'`. Add to the existing happy-path test after `accessRequests[3]`:

```ts
expect(accessRequests[4]?.logicalStepId).toBe('verification');
expect(accessRequests[4]?.stepInput).toMatchObject({
  changeSetArtifact: {
    stepId: 'implementation',
    artifactId: 'sealed-changes',
  },
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/workflow.test.ts`

Expected: FAIL — fixture still v1 (parseArtifact rejects) and/or `sealed-changes` is absent.

- [ ] **Step 3: Implement seal in `workflow.ts`**

Import:

```ts
import {
  AcceptancePathReservedError,
  canonicalJsonValue,
  sealChangeSet,
  // ...existing
} from '@agentos/core';
```

After the final `changeSet` / `testEvidence` / `reviewBody` are known (after the fix-or-not block, before `resolveTestCommand`, currently ~1513), and `dodBody` is already parsed at specification time — keep `dodBody` in scope (it already is from `:1204`).

Insert a helper next to `parseArtifact`:

```ts
async function putSealedChanges(
  dependencies: DurableFeatureWorkflowDependencies,
  workflow: FeatureWorkflowInput,
  producingStepId: string,
  changeSet: {
    readonly version: 'change-set-v1';
    readonly changes: ReturnType<typeof sealChangeSet>;
  },
): Promise<ArtifactMetadata> {
  return dependencies.artifacts.put({
    scope: {
      projectId: workflow.projectId,
      runId: workflow.runId,
      stepId: producingStepId,
    },
    artifactId: 'sealed-changes',
    version: 1,
    bytes: new TextEncoder().encode(canonicalJsonValue(asJson(changeSet))),
    mediaType: 'application/json',
    retentionClass: 'working',
  });
}
```

Seal:

```ts
let sealedChanges;
try {
  sealedChanges = {
    version: 'change-set-v1' as const,
    changes: sealChangeSet(changeSet.changes, dodBody.acceptanceTests),
  };
} catch (error) {
  if (error instanceof AcceptancePathReservedError) {
    throw new WorkflowPermanentError(error.message);
  }
  throw error;
}
const parsedSealed = changeSetSchema.safeParse(sealedChanges);
if (!parsedSealed.success) {
  throw new WorkflowPermanentError('sealed change set is invalid');
}
changeSet = parsedSealed.data;
const sealedMeta = await putSealedChanges(
  dependencies,
  workflow,
  producingStepId,
  changeSet,
);
```

Then:

- `changeSetDigest = hash(asJson(changeSet))` already follows — it now hashes the sealed set.
- Verification request: `changeSetArtifact: sealedMeta` instead of `implementation.changeSet`.
- `verifier.verify({ ..., changeSet: asJson(changeSet), ... })` already passes the in-memory object — now sealed.
- `publicationAuthority.authorize({ changeSet: asJson(changeSet), artifacts: [sealedMeta, implementation.changeSet, ...] })`.

Do not pass `sourcePaths` unless you already have the source bundle files in memory; default `add` is correct for empty experiment repos.

- [ ] **Step 4: Re-run workflow tests**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/workflow.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/trigger/workflow.ts packages/adapters/src/trigger/workflow.test.ts
git commit -m "$(cat <<'EOF'
Seal frozen acceptance tests onto the published change set.

EOF
)"
```

---

### Task 5: Specifier, implementer, and reviewer prompts

**Files:**

- Modify: `agentos/passerine.yaml:24-44,89-139`
- Modify: `apps/control-plane/src/ui/setup-template.ts` (same prompt strings)
- Modify: `apps/control-plane/src/ui/setup-template-local.ts` (same prompt strings)

These files are string mirrors. Edit all three. Do not regenerate via a script; there isn't one in-repo.

- [ ] **Step 1: Specifier — replace the DoD bullet**

Change artifact 2 body from v1 to:

```
{"version":"definition-of-done-v2","criteria":[{"id":"<slug like list-deep-copy>","description":"<criterion>","verifier":"test-report"}, ...],"acceptanceTests":[{"path":"test/acceptance/<id>.test.mjs","mode":"100644","content":"<node:test file that fails if this criterion is unmet>"}]}
```

Add after "Keep scope to exactly what is asked.":

```
For each requirement, add one criterion and one node:test file at test/acceptance/<id>.test.mjs. The file must fail if that requirement is unmet, including negative cases the requirement names (mutation, missing ids, identity). Do not test only the easy half of a copy. Each criterion id must have exactly that file; no extra files.
```

Keep specifier tools as `read`, `glob`, `grep` only.

- [ ] **Step 2: Implementer — one sentence after "Keep the diff minimal and complete."**

```
Do not add, modify, or delete files under test/acceptance/; trusted code overlays the approved acceptance tests.
```

- [ ] **Step 3: Reviewer — replace "Review the change set against the Definition of Done..."**

```
The Definition of Done artifact contains acceptance test files. Approve only if the change set would make those files pass; otherwise request changes with concrete findings. Review is advisory — sealed verification will run the files.
```

- [ ] **Step 4: Verify the three files agree**

Run: `rg -n "definition-of-done-v1" agentos/passerine.yaml apps/control-plane/src/ui/setup-template.ts apps/control-plane/src/ui/setup-template-local.ts`

Expected: no matches.

Run: `rg -n "definition-of-done-v2" agentos/passerine.yaml apps/control-plane/src/ui/setup-template.ts apps/control-plane/src/ui/setup-template-local.ts`

Expected: a hit in each file.

- [ ] **Step 5: Commit**

```bash
git add agentos/passerine.yaml apps/control-plane/src/ui/setup-template.ts apps/control-plane/src/ui/setup-template-local.ts
git commit -m "$(cat <<'EOF'
Ask the specifier to write frozen acceptance tests.

EOF
)"
```

---

### Task 6: Inbox shows the test files

**Files:**

- Modify: `apps/control-plane/src/application/control-plane-service.ts:265-272,1610-1692`
- Modify: `apps/control-plane/src/application/control-plane-service.test.ts` (approval-summary case)
- Modify: `apps/control-plane/src/http/contracts.ts:304-321`
- Modify: `apps/control-plane/src/ui/inbox-view.tsx:124-147`
- Modify: `apps/control-plane/src/ui/inbox-view.test.ts` if there is a summary render test; otherwise add a small assertion in `control-plane-service.test.ts` only and render by inspection of the JSX

**Interfaces:**

- Consumes: DoD v2 `acceptanceTests` from the specification artifact
- Produces: `ApprovalSummary.acceptanceTests: { path, content }[]` bounded at 8_000 chars per body

- [ ] **Step 1: Extend `ApprovalSummary` and the HTTP schema**

```ts
export interface ApprovalSummary {
  readonly title?: string;
  readonly requirements?: readonly string[];
  readonly criteria?: readonly {
    readonly id: string;
    readonly description: string;
  }[];
  readonly acceptanceTests?: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}
```

In `contracts.ts` `approvalSchema.summary`, add:

```ts
acceptanceTests: z
  .array(
    z
      .object({
        path: z.string().max(1_024),
        content: z.string().max(8_000),
      })
      .strict(),
  )
  .max(20)
  .optional(),
```

- [ ] **Step 2: Write a failing service test**

Find the existing test that projects a spec/DoD approval (search `feature-spec-and-dod` in `control-plane-service.test.ts`). If none reads artifacts, add one that:

1. Creates a run and a pending `feature-spec-and-dod` approval.
2. Puts specification + dod v2 artifacts on the in-memory artifact store used by the service (the service constructor already takes `artifacts` in tests that cover `approvalSummary` — if the default test service has no artifact store, pass `createInMemoryArtifactStorage().store`).
3. `listInbox` / `listApprovals` with summaries enabled.
4. Expects `summary.acceptanceTests[0].path === 'test/acceptance/status-test.test.mjs'` and the content to contain `node:test`.

If wiring artifacts into `createService` is new, follow the existing `approvalSummary` fail-soft test around `:1071` / digest tests and extend the factory.

- [ ] **Step 3: Implement `approvalSummary`**

After parsing `dod.criteria`, also:

```ts
const ACC_BOUND = 8_000;
const acceptanceTests = Array.isArray(
  (dod as { acceptanceTests?: unknown }).acceptanceTests,
)
  ? (dod as { acceptanceTests: unknown[] }).acceptanceTests
      .slice(0, 20)
      .flatMap((entry) => {
        if (entry === null || typeof entry !== 'object') return [];
        const candidate = entry as { path?: unknown; content?: unknown };
        const path = bounded(candidate.path);
        if (typeof candidate.content !== 'string' || path === undefined)
          return [];
        const content = redactText(candidate.content).slice(0, ACC_BOUND);
        return [{ path, content }];
      })
  : undefined;
```

Include `acceptanceTests` in the returned `summary` when non-empty. Treat missing tests as fail-soft (omit the field), same as missing requirements.

- [ ] **Step 4: Render in `inbox-view.tsx`**

Above the "It counts as done when" list:

```tsx
{summary.acceptanceTests === undefined ? null : (
  <>
    <p>
      <strong>It is done when these tests pass:</strong>
    </p>
    {summary.acceptanceTests.map((file) => (
      <div className="inbox-acceptance-test" key={file.path}>
        <p>
          <code>{file.path}</code>
        </p>
        <pre className="inbox-acceptance-test-body">{file.content}</pre>
      </div>
    ))}
  </>
)}
```

Add a class name; do not restyle the rest of the inbox.

- [ ] **Step 5: Run**

Run: `pnpm --filter @agentos/control-plane test -- src/application/control-plane-service.test.ts src/ui/inbox-view.test.ts src/http/contracts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/application/control-plane-service.ts apps/control-plane/src/application/control-plane-service.test.ts apps/control-plane/src/http/contracts.ts apps/control-plane/src/ui/inbox-view.tsx
git commit -m "$(cat <<'EOF'
Show frozen acceptance tests on the spec approval.

EOF
)"
```

---

### Task 7: Approval wait vs execution clock in the workflow

**Files:**

- Modify: `packages/adapters/src/trigger/types.ts:22-32`
- Modify: `packages/adapters/src/trigger/workflow.ts:123-133,1161-1162,1226-1265,1288-1352`
- Modify: `packages/adapters/src/trigger/workflow.test.ts:526-527`

**Interfaces:**

- Consumes: `FEATURE_WORKFLOW_DEFAULTS.workflowTimeoutMs` (meaning changes)
- Produces: `approvalTtlMs: 24 * 60 * 60 * 1_000`; spec-session deadline stays `createdAt + workflowTimeoutMs`; approval `expiresAt` and waitpoint use `approvalTtlMs`; after consume, `deadlineMs = consumedAt + workflowTimeoutMs`

- [ ] **Step 1: Failing assertions**

1. Add to `FEATURE_WORKFLOW_DEFAULTS` expectations if a types test exists; otherwise the waitpoint test is enough.
2. Change `workflow.test.ts:526-527` from `timeout: '3600s'` to `timeout: '86400s'`.
3. Add:

```ts
it('starts the execution deadline at approval consume, not run creation', async () => {
  const created = '2026-08-17T10:00:00.000Z';
  const consumed = '2026-08-17T12:00:00.000Z';
  const late = '2026-08-17T12:30:00.000Z';
  /* fixture with clock() returning created during spec, consumed during waiter.consume,
     late during planning onward. Spec session must succeed at created+30m equivalent;
     planning must still run at created+2.5h because consumed+60m is still ahead. */
});
```

Keep this test tight: reuse `fixture()`, but make `waiter.wait` consume at `'2026-08-17T12:00:00.000Z'` while `clock` after wait returns `'2026-08-17T12:30:00.000Z'`. Today `assertContinuable` uses `createdAt + 3600s` (`now` in the fixture is `'2026-08-17T12:00:00.000Z'` — read the fixture's `now` constant). If `now` is already equal to `createdAt`, shift: set run `createdAt` to `T`, consume at `T+2h`, clock after wait to `T+2h+1m`. That currently throws `workflow_deadline_exceeded`. After the fix it must complete.

Read the fixture `now` (`workflow.test.ts` top) and `createRunIdempotently` `createdAt: now`. If they are the same instant, the existing happy path never exercises a delayed consume. The new test must set `createdAt` two hours behind consume.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/workflow.test.ts`

Expected: FAIL on `86400s` and/or the delayed-consume test.

- [ ] **Step 3: Implement**

`types.ts`:

```ts
export const FEATURE_WORKFLOW_DEFAULTS = Object.freeze({
  concurrency: 1,
  maxStepAttempts: 2,
  sessionTimeoutMs: 20 * 60 * 1_000,
  workflowTimeoutMs: 60 * 60 * 1_000,
  approvalTtlMs: 24 * 60 * 60 * 1_000,
  workflowMicrodollars: 2_000_000,
  dailyMicrodollars: 5_000_000,
  admissionNumerator: 80,
  admissionDenominator: 100,
  defaultSessionReservationMicrodollars: 700_000,
});
```

`triggerWaitDuration`: change the upper bound from `workflowTimeoutMs` to `approvalTtlMs`.

At start of `run()` keep:

```ts
let deadlineMs =
  Date.parse(run.createdAt) + FEATURE_WORKFLOW_DEFAULTS.workflowTimeoutMs;
```

This remains the spec-session deadline.

When creating the approval (`:1226-1234`):

```ts
const approvalExpiresAt = new Date(
  Date.parse(run.createdAt) + FEATURE_WORKFLOW_DEFAULTS.approvalTtlMs,
);
expiresAt: at(approvalExpiresAt.toISOString()),
```

Waitpoint payload `deadline` and `triggerWaitDuration(approvalExpiresAt.getTime(), ...)` — not `deadlineMs`.

On `timed_out`, expire with `at: at(approvalExpiresAt.toISOString())` (not execution `deadlineMs`).

Immediately after `decision === 'approve'` and before the post-approval `assertContinuable` (`:1344`):

```ts
const consumed = await dependencies.repository.getApproval(
  persistenceId('approval', approvalId),
);
if (consumed?.consumedAt === undefined) {
  throw new WorkflowPermanentError('approval_consumed_at_missing');
}
deadlineMs =
  Date.parse(consumed.consumedAt) +
  FEATURE_WORKFLOW_DEFAULTS.workflowTimeoutMs;
```

Do not auto-approve.

- [ ] **Step 4: Re-run**

Run: `pnpm --filter @agentos/adapters test -- src/trigger/workflow.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/trigger/types.ts packages/adapters/src/trigger/workflow.ts packages/adapters/src/trigger/workflow.test.ts
git commit -m "$(cat <<'EOF'
Start the workflow clock when the spec is approved.

EOF
)"
```

---

### Task 8: Reconciliation respects waiting vs executing

**Files:**

- Modify: `apps/control-plane/src/application/workflow-reconciliation.ts:34-63,214-240`
- Modify: `apps/control-plane/src/application/workflow-reconciliation.test.ts`

**Interfaces:**

- Consumes: `listApprovals`, `listGoalProgress`, `getRun`
- Produces: the four spec rules; `MAX_WORKFLOW_TIMEOUT_MS` stays `60 * 60_000`

- [ ] **Step 1: Write failing reconciliation tests** next to `'uses the configured bounded goal timeout before the one-hour ceiling'`

Use the same in-memory repository / `reconcileWorkflowOutbox` harness.

1. **Waiting feature, live approval, createdAt + 90m:** status stays `waiting`. Clock = `createdAt + 90m`. Approval `expiresAt` = `createdAt + 24h`. Must not be `workflow_deadline_exceeded`.

2. **Waiting feature, expired approval:** `expiresAt` in the past → run `failed` with `error.code === 'approval_expired'`, approval status `expired`.

3. **Running feature after consume:** `createdAt` 90m ago, `consumedAt` 10m ago → still running. Same run with `consumedAt` 61m ago → `workflow_deadline_exceeded`.

4. **Goal parent with waiting child:** parent `running`, `createdAt` 90m ago, a progress row pointing at a `waiting` feature child → parent not failed. After the child is `succeeded` with `completedAt` 61m ago and parent still `running` → parent `workflow_deadline_exceeded`.

5. Keep the existing goal-timeout test: a goal with no children still dies at the configured short timeout from `createdAt`.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @agentos/control-plane test -- src/application/workflow-reconciliation.test.ts`

Expected: FAIL — waiting runs still die at 60m from `createdAt`.

- [ ] **Step 3: Replace the `deadlineExceeded` block**

Keep `MAX_WORKFLOW_TIMEOUT_MS = 60 * 60_000`. Add helpers in the same file (no new module):

```ts
const TERMINAL = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
  'expired',
]);

async function specDodApproval(
  repository: DomainRepository,
  runId: WorkflowRunId,
): Promise<Approval | undefined> {
  const pending = await repository.listApprovals(runId, {
    status: 'pending',
    limit: 100,
  });
  const consumed = await repository.listApprovals(runId, {
    status: 'consumed',
    limit: 100,
  });
  return [...pending, ...consumed].find(
    (approval) => approval.scope === 'feature-spec-and-dod',
  );
}

async function goalChildRuns(
  repository: DomainRepository,
  parent: WorkflowRun,
): Promise<readonly WorkflowRun[]> {
  const progress = await repository.listGoalProgress(parent.id, { limit: 100 });
  const children: WorkflowRun[] = [];
  for (const record of progress) {
    if (record.criterionId !== undefined || !isObject(record.payload)) continue;
    const childRunId = record.payload.childRunId;
    if (typeof childRunId !== 'string') continue;
    const expected = deterministicGoalChildRunId(parent.id, record.step);
    if (childRunId !== expected) continue;
    const child = await repository.getRun(expected);
    if (child !== undefined) children.push(child);
  }
  return children;
}
```

Replace `deadlineExceeded` computation:

```ts
const nowMs = Date.parse(now);
let failCode: 'workflow_deadline_exceeded' | 'approval_expired' | undefined;

if (active && (run.pipeline === 'feature' || run.pipeline === 'goal')) {
  if (run.status === 'waiting') {
    const approval = await specDodApproval(repository, run.id);
    if (
      approval?.status === 'pending' &&
      Date.parse(approval.expiresAt) <= nowMs
    ) {
      failCode = 'approval_expired';
      await repository.expireApproval(approval.id, {
        runId: run.id,
        scope: approval.scope,
        fingerprint: approval.fingerprint,
        at: isoTimestamp(now),
      });
    }
  } else if (run.pipeline === 'feature') {
    const approval = await specDodApproval(repository, run.id);
    const startMs =
      approval?.status === 'consumed' && approval.consumedAt !== undefined
        ? Date.parse(approval.consumedAt)
        : Date.parse(run.createdAt);
    if (nowMs >= startMs + MAX_WORKFLOW_TIMEOUT_MS) {
      failCode = 'workflow_deadline_exceeded';
    }
  } else {
    const children = await goalChildRuns(repository, run);
    const live = children.filter((child) => !TERMINAL.has(child.status));
    if (live.length === 0) {
      const cap = await workflowTimeoutMs(repository, run);
      const lastCompleted = children
        .map((child) =>
          child.completedAt === undefined
            ? undefined
            : Date.parse(child.completedAt),
        )
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => right - left)[0];
      const startMs = lastCompleted ?? Date.parse(run.createdAt);
      if (nowMs >= startMs + cap) failCode = 'workflow_deadline_exceeded';
    }
  }
}
```

Use `failCode` in the existing `transitionRun` to `failed` block. For `approval_expired`, set `error: { code: 'approval_expired' }` and `output.reason` the same. Continue to request cancel + cleanup as today's deadline path does.

`waiting` with a still-live approval: do nothing (no execution deadline).

Import `Approval` type from `@agentos/core` if not already.

- [ ] **Step 4: Re-run**

Run: `pnpm --filter @agentos/control-plane test -- src/application/workflow-reconciliation.test.ts`

Expected: PASS. Existing goal-timeout test still passes (no children → `createdAt + cap`).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/application/workflow-reconciliation.ts apps/control-plane/src/application/workflow-reconciliation.test.ts
git commit -m "$(cat <<'EOF'
Do not kill runs that are waiting on a live approval.

EOF
)"
```

---

### Task 9: Architecture docs and spec coverage

**Files:**

- Modify: `docs/architecture/durable-feature-workflow.md:18-40,110-120`
- Spec is already `Status: Approved design`

- [ ] **Step 1: Execution path**

Step 2: specifier writes hashed specification plus `definition-of-done-v2` with one `test/acceptance/<id>.test.mjs` per criterion.

Step 3: unchanged (scope hash, approval). Inbox shows the acceptance file bodies.

Step 5: after implementation, trusted code seals those files onto the change set (`sealed-changes`). Verification materializes the sealed set and runs the allowlisted project command **and** `node --test test/acceptance/`. An implementer change under `test/acceptance/` is a permanent error.

- [ ] **Step 2: Limits bullet**

Replace "an absolute 60-minute domain deadline, including approval waits" with:

- approvals wait up to 24 hours (`approvalTtlMs`); the 60-minute execution budget starts when the spec/DoD approval is consumed
- a run in `waiting` with a live approval is not failed for the execution deadline
- a goal parent with a non-terminal child is not failed for the execution deadline

- [ ] **Step 3: Grep for stale v1 / old deadline copy**

Run: `rg -n "definition-of-done-v1|including approval waits" --glob '!docs/superpowers/**' --glob '!**/node_modules/**'`

Expected: no remaining production hits. Superpowers spec/plan may still mention v1 as the *old* contract.

- [ ] **Step 4: Full credential-free suites touched by this plan**

Run:

```sh
pnpm --filter @agentos/core test -- src/acceptance-tests.test.ts
pnpm --filter @agentos/adapters test -- src/trigger/schemas.test.ts src/trigger/verifier.test.ts src/trigger/goal-verifier.seam.test.ts src/trigger/production-handler.test.ts src/trigger/workflow.test.ts
pnpm --filter @agentos/control-plane test -- src/application/control-plane-service.test.ts src/application/workflow-reconciliation.test.ts src/ui/inbox-view.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/durable-feature-workflow.md docs/superpowers/specs/2026-08-20-frozen-acceptance-dod-design.md docs/superpowers/plans/2026-08-20-frozen-acceptance-dod.md
git commit -m "$(cat <<'EOF'
Document frozen acceptance tests and the split approval clock.

EOF
)"
```

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| v2 schema, 1:1 pairing, prefix, size caps | 1, 2 |
| Specifier writes files; no write/bash | 5 |
| `sealChangeSet` + reserved-path error | 1, 4 |
| `sealed-changes` artifact; digest binds sealed set | 4 |
| `node --test test/acceptance/` suffix; remap | 3 |
| Inbox shows file bodies, 8_000 bound | 6 |
| `approvalTtlMs` 24h; waitpoint bound; consume starts clock | 7 |
| Reconciliation waiting/expired/consumed/goal-child rules | 8 |
| Architecture limits + execution path | 9 |
| No `dod.ts`, no auto-approve, no red-phase | Global constraints |

## Self-review

- No TBD/TODO placeholders.
- `sealChangeSet` / `AcceptancePathReservedError` names are identical in Tasks 1 and 4.
- Waitpoint timeout `86400s` matches `approvalTtlMs`.
- Verification remap and workflow `artifactId: 'sealed-changes'` match.
- Goal parent rule uses `completedAt` of children, not a new column.

Manual check after implementation (not a CI test): overlay the shallow `createTodoStore` from `todo-app-02` with the two mutation tests from the spec; sealed verification must fail.
