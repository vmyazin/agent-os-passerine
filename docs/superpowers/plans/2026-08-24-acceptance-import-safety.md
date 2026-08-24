# Acceptance Import Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject frozen acceptance tests whose literal ESM imports resolve outside the repository, and teach the specifier the correct relative-path calculation.

**Architecture:** `@agentos/core` exposes a synchronous pure validator backed by `es-module-lexer`. The Trigger DoD schema attaches a content-scoped issue without echoing source, while all three prompt sources receive the same concrete path example.

**Tech Stack:** TypeScript, Vitest, Zod, `es-module-lexer`, YAML prompt templates

---

## File map

- `packages/core/src/acceptance-tests.ts:1-92` — extract literal ESM module specifiers and resolve relative imports under a sentinel repository root.
- `packages/core/src/acceptance-tests.test.ts:1-116` — unit coverage for internal, escaping, absolute, bare, Node, comment, and string cases.
- `packages/core/package.json:15-18` and `pnpm-lock.yaml` — declare the module lexer as a direct runtime dependency.
- `packages/adapters/src/trigger/schemas.ts:1-7,180-236` — add a content-path schema issue when the validator reports an unsafe import.
- `packages/adapters/src/trigger/schemas.test.ts:116-177` — replay the rejected live import and prove the corrected import passes without source leakage.
- `agentos/passerine.yaml:29-44` — canonical specifier prompt example.
- `apps/control-plane/src/ui/setup-template.ts:31-46` — GitHub setup prompt example.
- `apps/control-plane/src/ui/setup-template-local.ts:31-46` — local setup prompt example.
- `apps/control-plane/src/ui/setup-template-render.test.ts:8-46` — guard all three prompt sources against drift.

## Do not modify

- Artifact storage or artifact capability metadata.
- Approval creation, consumption, or scope hashing.
- Trusted test execution, source ingestion, change-set sealing, or publication.
- Acceptance-test directory, file mode, allowed Node APIs, or verifier contract.

### Task 1: Core module-import containment

**Files:**

- Modify: `packages/core/src/acceptance-tests.test.ts:1-46`
- Modify: `packages/core/src/acceptance-tests.ts:1-68`
- Modify: `packages/core/package.json:15-18`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Write the failing core tests**

Add table-driven tests calling this intended API:

```ts
expect(
  acceptanceTestImportSafetyError({
    path: 'test/acceptance/list-deep-copy.test.mjs',
    content: "import { list } from '../../../src/todo-store.mjs';",
  }),
).toBe('acceptance test import resolves outside repository');

expect(
  acceptanceTestImportSafetyError({
    path: 'test/acceptance/list-deep-copy.test.mjs',
    content: "import { list } from '../../src/todo-store.mjs';",
  }),
).toBeUndefined();
```

Cover `import from`, side-effect import, `export from`, literal `import()`, absolute POSIX and Windows paths, `node:test`, bare packages, and import-looking text in comments and strings.

- [x] **Step 2: Run the core test and verify RED**

Run: `pnpm --filter @agentos/core test -- acceptance-tests.test.ts`

Expected: FAIL because `acceptanceTestImportSafetyError` is not exported.

- [x] **Step 3: Add the direct lexer dependency**

Declare `"es-module-lexer": "2.3.1"` in `packages/core/package.json`, then run `pnpm install --lockfile-only` to update the lockfile without changing unrelated versions.

- [x] **Step 4: Implement the minimal pure validator**

Initialize `es-module-lexer` synchronously, parse only literal module names, and resolve relative names against `/repository/<acceptance path>`. Return the stable bounded error for any absolute filesystem specifier or any relative target whose `path.posix.relative('/repository', target)` starts with `..` or is absolute. Ignore non-literal dynamic imports, bare specifiers, and `node:` built-ins.

- [x] **Step 5: Run the core test and verify GREEN**

Run: `pnpm --filter @agentos/core test -- acceptance-tests.test.ts`

Expected: PASS with all acceptance-test cases green.

### Task 2: DoD schema enforcement

**Files:**

- Modify: `packages/adapters/src/trigger/schemas.test.ts:116-177`
- Modify: `packages/adapters/src/trigger/schemas.ts:1-7,209-236`

- [x] **Step 1: Write the failing live-shape schema regression**

Use the exact rejected path relationship:

```ts
const rejected = definitionOfDoneSchema.safeParse({
  ...valid,
  acceptanceTests: [
    {
      path: 'test/acceptance/list-deep-copy.test.mjs',
      mode: '100644',
      content: "import { list } from '../../../src/todo-store.mjs';",
    },
  ],
});
expect(rejected.success).toBe(false);
expect(rejected.success ? [] : rejected.error.issues).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ path: ['acceptanceTests', 0, 'content'] }),
  ]),
);
```

Add the corrected `../../src/todo-store.mjs` pass case and assert the formatted schema failure contains only the field path, not the source or specifier.

- [x] **Step 2: Run the adapter test and verify RED**

Run: `pnpm turbo run build --filter=@agentos/core && pnpm --filter @agentos/adapters test -- schemas.test.ts`

Expected: FAIL because the escaping import still satisfies the schema.

- [x] **Step 3: Apply the validator in the schema refinement**

Iterate with an index and add exactly this bounded issue shape:

```ts
context.addIssue({
  code: 'custom',
  path: ['acceptanceTests', index, 'content'],
  message: 'acceptance test import resolves outside repository',
});
```

- [x] **Step 4: Run the adapter test and verify GREEN**

Run: `pnpm turbo run build --filter=@agentos/core && pnpm --filter @agentos/adapters test -- schemas.test.ts`

Expected: PASS.

### Task 3: Prompt guidance parity

**Files:**

- Modify: `apps/control-plane/src/ui/setup-template-render.test.ts:8-46`
- Modify: `agentos/passerine.yaml:29-44`
- Modify: `apps/control-plane/src/ui/setup-template.ts:31-46`
- Modify: `apps/control-plane/src/ui/setup-template-local.ts:31-46`

- [x] **Step 1: Write the failing prompt-parity test**

Read `agentos/passerine.yaml` and assert it and both exported templates include the exact sentence fragment `src/example.mjs` and `../../src/example.mjs`.

- [x] **Step 2: Run the control-plane test and verify RED**

Run: `pnpm --filter @agentos/control-plane test -- setup-template-render.test.ts`

Expected: FAIL because no prompt contains the concrete example.

- [x] **Step 3: Add the same example to all prompt sources**

Add: `For example, src/example.mjs is imported from test/acceptance/<id>.test.mjs as ../../src/example.mjs.` Keep the existing no-write and dependency-free instructions unchanged.

- [x] **Step 4: Run the control-plane test and verify GREEN**

Run: `pnpm --filter @agentos/control-plane test -- setup-template-render.test.ts`

Expected: PASS.

- [x] **Step 5: Verify the complete acceptance change**

Run: `pnpm --filter @agentos/core test && pnpm --filter @agentos/core typecheck && pnpm turbo run build --filter=@agentos/core && pnpm --filter @agentos/adapters test -- schemas.test.ts && pnpm --filter @agentos/adapters typecheck && pnpm --filter @agentos/control-plane test -- setup-template-render.test.ts`

Expected: every command exits 0. Do not commit; the user did not authorize commits.
