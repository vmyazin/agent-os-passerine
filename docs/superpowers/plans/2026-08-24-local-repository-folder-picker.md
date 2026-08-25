# Local Repository Folder Picker Implementation Plan

**Follow-up decision (2026-08-24):** After approving the localhost UI, the user
authorized a local commit. This overrides the earlier no-commit constraint;
push remains unauthorized.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. The user declined a worktree, so work in the current checkout and
> preserve unrelated files.

**Goal:** Let a local macOS operator choose a repository directory in Finder and
populate the existing exact-path import field.

**Architecture:** A server-only native capability runs one static AppleScript
through `execFile`. A session-only, same-origin API route exposes selected versus
cancelled results, while server pages pass capability availability into the
existing Radix import dialog.

**Tech Stack:** TypeScript, Node.js `child_process`, Next.js 16, React 19, Radix
Dialog/RadioGroup, Vitest, Playwright.

---

## File map

- Create `apps/control-plane/src/local-system/directory-picker.ts`: availability
  gate, bounded native command adapter, and selected/cancelled result contract.
- Create `apps/control-plane/src/local-system/directory-picker.test.ts`: isolated
  native-boundary tests with an injected command runner.
- Create `apps/control-plane/app/api/projects/import/select-directory/route.ts`:
  authenticated session-only route using the standard API error boundary.
- Create `apps/control-plane/src/http/directory-picker-route.test.ts`: route auth,
  origin, availability, cancellation, and output tests.
- Modify `apps/control-plane/src/http/contracts.ts`: response schema for the
  selected/cancelled union.
- Modify `apps/control-plane/src/ui/import-project-dialog.tsx:33-238`: capability
  prop, picker request state, accessible control, and focus restoration.
- Modify `apps/control-plane/app/projects/page.tsx:1-39`: pass native capability
  availability to the toolbar dialog.
- Modify `apps/control-plane/app/projects/[id]/page.tsx:1-170`: pass availability
  to the source-less project dialog.
- Modify `apps/control-plane/app/globals.css:1724-1943`: inline path/action layout,
  secondary action styling, and narrow-screen stacking.
- Modify `tests/e2e/scaffold.spec.ts:79-126`: mocked native-picker interaction.

## Do not modify

- `packages/core/**` or `packages/adapters/**`.
- Project-source persistence, inspection, commit paging, or Git commands.
- Source ingestion, publication, runtime/workflow dispatch, Trigger tasks, or
  prompts.
- Generated repository wiki content.
- The unrelated untracked `agentos/agent-os.yaml` file.

### Task 1: Native macOS directory capability

**Files:**
- Create: `apps/control-plane/src/local-system/directory-picker.test.ts`
- Create: `apps/control-plane/src/local-system/directory-picker.ts`

- [x] **Step 1: Write failing availability and native-result tests**

Cover these exact cases with an injected `runFile` function:

```ts
expect(isLocalDirectoryPickerAvailable(localEnv, 'darwin')).toBe(true);
expect(isLocalDirectoryPickerAvailable(localEnv, 'linux')).toBe(false);
expect(isLocalDirectoryPickerAvailable(productionEnv, 'darwin')).toBe(false);
await expect(selectLocalDirectory({ runFile: selected })).resolves.toEqual({
  status: 'selected',
  path: '/Users/operator/repository',
});
await expect(selectLocalDirectory({ runFile: cancelled })).resolves.toEqual({
  status: 'cancelled',
});
```

Also assert the runner receives `/usr/bin/osascript`, a static argument array,
`shell: false`, a timeout, and a small `maxBuffer`; reject embedded NULs and
output beyond the path-length bound.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @agentos/control-plane test -- directory-picker.test.ts
```

Expected: FAIL because the directory-picker module does not exist.

- [x] **Step 3: Implement the minimal server-only helper**

Use these public shapes:

```ts
export type DirectoryPickerResult =
  | { readonly status: 'selected'; readonly path: string }
  | { readonly status: 'cancelled' };

export function isLocalDirectoryPickerAvailable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean;

export async function selectLocalDirectory(options?: {
  readonly runFile?: RunFile;
}): Promise<DirectoryPickerResult>;
```

The static AppleScript must catch error number `-128` and return an empty string.
Remove only the command's final line ending; do not trim legitimate whitespace
from a path.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the same Vitest command. Expected: PASS.

### Task 2: Session-only selection endpoint

**Files:**
- Modify: `apps/control-plane/src/http/contracts.ts`
- Create: `apps/control-plane/app/api/projects/import/select-directory/route.ts`
- Create: `apps/control-plane/src/http/directory-picker-route.test.ts`

- [x] **Step 1: Write failing route tests**

Mock `selectLocalDirectory` and verify:

```ts
expect(unauthenticated.status).toBe(401);
expect(crossOrigin.status).toBe(403);
expect(cliToken.status).toBe(403);
expect(unavailable.status).toBe(404);
await expect(selected.json()).resolves.toEqual({
  status: 'selected',
  path: '/Users/operator/repository',
});
await expect(cancelled.json()).resolves.toEqual({ status: 'cancelled' });
```

Assert the mocked native helper is not called for every rejected request.

- [x] **Step 2: Run the route test and verify RED**

```bash
pnpm --filter @agentos/control-plane test -- directory-picker-route.test.ts
```

Expected: FAIL because the route does not exist.

- [x] **Step 3: Implement the route through `handleApi`**

Define a strict empty-object request body and this response union:

```ts
export const directoryPickerResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('selected'), path: z.string().min(1).max(4096) }),
  z.object({ status: z.literal('cancelled') }),
]);
```

The route's authorization closure must call `requireApiAuthentication(request)`,
reject any identity other than `{ kind: 'session' }`, and check native capability
availability before its handler calls `selectLocalDirectory()`.

- [x] **Step 4: Run route and existing source-route tests**

```bash
pnpm --filter @agentos/control-plane test -- directory-picker-route.test.ts project-source-routes.test.ts
```

Expected: PASS.

### Task 3: Import-dialog picker interaction

**Files:**
- Modify: `apps/control-plane/src/ui/import-project-dialog.tsx`
- Modify: `apps/control-plane/app/projects/page.tsx`
- Modify: `apps/control-plane/app/projects/[id]/page.tsx`
- Modify: `apps/control-plane/app/globals.css`
- Modify: `tests/e2e/scaffold.spec.ts`

- [x] **Step 1: Add a failing mocked Playwright scenario**

Fulfill the picker request without opening Finder:

```ts
await page.route('**/api/projects/import/select-directory', (route) =>
  route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'selected',
      path: process.cwd(),
    }),
  }),
);
await page.getByRole('button', { name: 'Choose folder' }).click();
await expect(page.getByLabel('Repository path')).toHaveValue(process.cwd());
await expect(page.getByLabel('Repository path')).toBeFocused();
```

Add cancellation and error assertions showing the previous path remains intact.

- [x] **Step 2: Run the scenario and verify RED**

```bash
pnpm exec playwright test tests/e2e/scaffold.spec.ts --grep "folder picker"
```

Expected: FAIL because **Choose folder…** is absent.

- [x] **Step 3: Implement capability props and picker state**

Extend the component API without changing existing callers' default behavior:

```ts
export function ImportProjectDialog({
  triggerLabel = 'Import project',
  localPickerAvailable = false,
}: {
  readonly triggerLabel?: string;
  readonly localPickerAvailable?: boolean;
})
```

Add `'choose'` to pending state. The picker sends `POST` with same-origin JSON
headers and `{}` body. On `selected`, update `location`, clear stale inspection
and messages, then focus the path input. On `cancelled`, change no form state.
Use a real `<button type="button" className="secondary">Choose folder…</button>`
inside `.repository-path-control` and keep the Radix dialog open.

Both server pages pass:

```tsx
localPickerAvailable={isLocalDirectoryPickerAvailable()}
```

- [x] **Step 4: Add responsive styling and verify GREEN**

Use `minmax(0, 1fr) auto` for the desktop path row and stack it inside the
existing `@media (max-width: 640px)` block. Preserve all existing tokens and
focus styles. Re-run the focused Playwright scenario; expected: PASS.

### Task 4: Full verification and smoke test

**Files:** No production files beyond Tasks 1-3.

- [x] **Step 1: Run control-plane verification**

```bash
pnpm --filter @agentos/control-plane test
pnpm --filter @agentos/control-plane typecheck
pnpm --filter @agentos/control-plane lint
pnpm --filter @agentos/control-plane build
```

Expected: all commands exit 0.

- [x] **Step 2: Run browser regression coverage**

```bash
pnpm exec playwright test tests/e2e/scaffold.spec.ts
```

Expected: PASS, including keyboard import and mocked folder selection.

- [x] **Step 3: Smoke-test on a non-default port**

Start Next directly on port `3107`, authenticate locally, open `/projects`, and
verify the local repository form renders **Choose folder…**, Finder opens, cancel
preserves the form, and selecting this repository fills its absolute path.

- [x] **Step 4: Request explicit UI approval**

Provide `http://localhost:3107/projects`. Do not commit or push unless the user
separately authorizes it.
