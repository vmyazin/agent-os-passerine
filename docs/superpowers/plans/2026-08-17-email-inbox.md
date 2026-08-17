# Email-style Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the inbox card grid into a clean, responsive email-style request queue and reading pane without changing domain behavior.

**Architecture:** Add a focused client-side `InboxView` that combines existing approval and inbox projections into a local selectable list. Keep server data loading in the route and reuse the existing mutation forms for all writes. Scope all new styling to the inbox surface.

**Tech Stack:** Next.js App Router, React 19, TypeScript, CSS, Vitest, React DOM server rendering, Playwright.

---

### Task 1: Specify the inbox view behavior

**Files:**

- Create: `apps/control-plane/src/ui/inbox-view.test.tsx`
- Create: `apps/control-plane/src/ui/inbox-view.tsx`

- [ ] **Step 1: Write failing rendering tests**

Test that mixed approvals and questions render as one named request list, select
the newest item by default, expose human-readable message text, preserve scope
metadata, and label item selection accessibly.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @agentos/control-plane test -- src/ui/inbox-view.test.tsx`

Expected: FAIL because `inbox-view.tsx` does not exist.

- [ ] **Step 3: Implement the minimal selectable inbox view**

Create a discriminated request item model, deterministic newest-first ordering,
readable body extraction, native selection buttons, and a selected reading pane
that embeds `ApprovalActions` or `ReplyForm`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @agentos/control-plane test -- src/ui/inbox-view.test.tsx`

Expected: all focused tests pass.

### Task 2: Integrate the route and email-style visual system

**Files:**

- Modify: `apps/control-plane/app/inbox/page.tsx`
- Modify: `apps/control-plane/app/globals.css`

- [ ] **Step 1: Replace card rendering with `InboxView`**

Keep authentication, service loading, and the existing empty state in the server
route. Pass pending approvals and messages into the client view.

- [ ] **Step 2: Add scoped mailbox styles**

Implement the compact toolbar, continuous queue rows, selected state, reading
pane, metadata disclosure, restrained form controls, and stacked mobile layout
using existing tokens.

- [ ] **Step 3: Run component tests, typecheck, and lint**

Run:

```sh
pnpm --filter @agentos/control-plane test
pnpm --filter @agentos/control-plane typecheck
pnpm --filter @agentos/control-plane lint
```

Expected: all commands exit 0.

### Task 3: Verify the operator workflow in a real browser

**Files:**

- Modify: `tests/e2e/scaffold.spec.ts`
- Modify: `docs/progress.md`

- [ ] **Step 1: Add email-inbox assertions before implementation verification**

Assert that the pending-request region, selected item state, reading pane, scope
hash, question switching, reply form, and 390 px no-overflow behavior are visible.

- [ ] **Step 2: Run the focused browser case**

Run: `pnpm exec playwright test tests/e2e/scaffold.spec.ts --grep inbox`

Expected: all inbox cases pass, or record a bounded host browser-launch failure
without representing it as a product result.

- [ ] **Step 3: Inspect desktop and mobile screenshots in the in-app browser**

Check hierarchy, text wrapping, selected/focus states, action clarity, and
horizontal overflow at desktop and 390 px.

- [ ] **Step 4: Update progress and run final gates**

Run:

```sh
pnpm --filter @agentos/control-plane test
pnpm --filter @agentos/control-plane typecheck
pnpm --filter @agentos/control-plane lint
pnpm --filter @agentos/control-plane build
pnpm format:check
git diff --check
```

Expected: all commands exit 0.
