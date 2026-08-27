# Live Inbox Rail Count Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Keep the Inbox badge in the primary rail synchronized with all pending approvals and unanswered messages, without requiring navigation or a page reload.

**Architecture:** Preserve the server-rendered count as the first-paint seed. Add one authenticated count-only endpoint backed by the existing `countInboxAttention` rule, then let a small client subscription refresh it on mount, every 15 seconds while visible, on focus/visibility restoration, and after a successful inbox mutation. The client preserves the last known count on failures and serializes overlapping refresh requests.

**Tech Stack:** Next.js App Router, React client components, TypeScript, Zod, Vitest, Playwright.

**Acceptance source:** `docs/superpowers/specs/2026-08-27-live-inbox-rail-count-design.md`

## Follow-up decision — review corrections

Review on 2026-08-27 supersedes the bounded count query and document reload
steps below. Count every repository page through the control-plane service,
and finish successful Inbox mutations with invalidation plus
`router.refresh()` so the rail subscription remains mounted.

## File map

- `apps/control-plane/src/http/contracts.ts:588-595` — add the strict count-only response schema.
- `apps/control-plane/src/application/control-plane-service.ts:2418-2505` — add exact paginated attention counting without changing persistence interfaces.
- `apps/control-plane/src/ui/rail-counts.ts:1-36` — expose the shared attention-count query and keep the layout's fail-soft behavior.
- `apps/control-plane/app/api/inbox/count/route.ts` — add the authenticated count-only GET route.
- `apps/control-plane/src/http/inbox-count-route.test.ts` — prove authentication and count semantics through the route.
- `apps/control-plane/src/ui/inbox-count-client.ts` — own fetch validation, display/accessible formatting, browser triggers, polling, serialization, and cleanup.
- `apps/control-plane/src/ui/inbox-count-client.test.ts` — prove the client controller without a browser DOM.
- `apps/control-plane/src/ui/app-rail-nav.tsx:1-76` — seed and render the live count.
- `apps/control-plane/src/ui/mutation-forms.tsx:1-55,206-235` — publish a refresh signal only after successful approval/rejection/reply mutations.
- `apps/control-plane/src/ui/inbox-mutation-success.ts` — sequence invalidation before a route refresh.
- `apps/control-plane/src/ui/inbox-mutation-success.test.ts` — prove that success sequencing.
- `tests/e2e/scaffold.spec.ts:170-230` — prove the rail count is exposed accessibly and decreases immediately as requests are consumed.

## Do not modify

- Approval, rejection, or reply API semantics and persistence.
- Inbox item ordering, selection, or digest rendering.
- Workflow/reconciliation/Trigger.dev code.
- Authentication policy or session handling.
- The existing project-count signal contract.
- Global rail layout or badge styling unless verification proves `99+` does not fit the existing pill.
- Any pre-existing bootstrap, Kimi, usage-settlement, provider, or dependency changes already present in this worktree.

---

### Task 1: Add a count-only authenticated API contract

**Files:**
- Create: `apps/control-plane/src/http/inbox-count-route.test.ts`
- Modify: `apps/control-plane/src/http/contracts.ts`
- Modify: `apps/control-plane/src/ui/rail-counts.ts`
- Create: `apps/control-plane/app/api/inbox/count/route.ts`

- [ ] Write a focused route test that resets the in-memory repository/runtime, verifies an unauthenticated request returns 401, seeds one pending message, one replied message, one pending approval, and one non-pending approval, then expects `{ count: 2 }` from an authenticated request.
- [ ] Run `pnpm --filter @agentos/control-plane test -- src/http/inbox-count-route.test.ts` and observe RED because the route does not exist.
- [ ] Add `inboxCountSchema` as a strict object with one nonnegative safe integer `count` field.
- [ ] Extract `fetchInboxAttentionCount()` in `rail-counts.ts`; it must query `listInbox()` and `listPendingApprovals(50, false)` concurrently and delegate counting to `countInboxAttention`.
- [ ] Keep `fetchRailCounts()` fail-soft, but compose the extracted count query with waiting-run and project counts.
- [ ] Implement `GET /api/inbox/count` with `handleApi`, `requireApiAuthentication`, and `inboxCountSchema`.
- [ ] Re-run the focused route test and observe GREEN.

### Task 2: Build and prove the live count client

**Files:**
- Create: `apps/control-plane/src/ui/inbox-count-client.test.ts`
- Create: `apps/control-plane/src/ui/inbox-count-client.ts`

- [ ] Write formatter tests for hidden zero at the caller boundary, exact `1` through `99`, visible `99+` above 99, and accessible labels `Inbox, 1 item needs attention` / `Inbox, 143 items need attention` using the uncapped count.
- [ ] Write fetch tests proving successful strict payloads update the count while non-OK, malformed, negative, fractional, and unsafe counts return `undefined`.
- [ ] Write subscription tests with injected `EventTarget`, visible-state getter, fetcher, and timer functions. Prove: initial refresh; 15-second callback only fetches while visible; focus, visible restoration, and the inbox mutation event refresh; overlapping triggers serialize with one trailing refresh; failed refreshes do not call the listener; cleanup removes listeners, clears the timer, and aborts the active request.
- [ ] Run `pnpm --filter @agentos/control-plane test -- src/ui/inbox-count-client.test.ts` and observe RED because the module does not exist.
- [ ] Implement `formatInboxAttentionCount`, `inboxAttentionAriaLabel`, `fetchInboxAttentionCount`, `publishInboxAttentionChanged`, and `subscribeToInboxAttentionCount` with one in-flight request and one queued trailing refresh.
- [ ] Re-run the focused client test and observe GREEN.

### Task 3: Connect the rail and successful inbox mutations

**Files:**
- Modify: `apps/control-plane/src/ui/app-rail-nav.tsx`
- Modify: `apps/control-plane/src/ui/mutation-forms.tsx`

- [ ] Extend the client test or add a static-render test proving the count helpers used by the rail hide zero, cap only visible text, and retain the true count in the accessible label; run it RED before editing the rail if the assertion is new.
- [ ] In `AppRailNav`, seed `liveInboxCount` from the server prop, re-seed on prop changes, subscribe once to live count updates, hide zero, render the formatted badge, and use the inbox-specific accessible label.
- [ ] Add an optional success callback to the private mutation hook. Invoke it only for successful responses before the existing reload.
- [ ] Pass `publishInboxAttentionChanged` to approval/rejection and reply forms, but not unrelated restart/cancel mutations.
- [ ] Run `pnpm --filter @agentos/control-plane test -- src/ui/inbox-count-client.test.ts src/http/inbox-count-route.test.ts` and observe GREEN.
- [ ] Run `pnpm --filter @agentos/control-plane typecheck` and fix only errors introduced by this feature.

### Task 4: Prove the operator workflow in a real browser

**Files:**
- Modify: `tests/e2e/scaffold.spec.ts`

- [ ] In the existing approval-and-reply scenario, account for the independent seeded spec approval: assert the initial navigation name is `Inbox, 3 items need attention`, approval changes it to `Inbox, 2 items need attention`, and reply changes it to `Inbox, 1 item needs attention`.
- [ ] Run `pnpm exec playwright test tests/e2e/scaffold.spec.ts --grep "consume a scoped approval"` and observe RED before the production wiring is complete or when temporarily checking out the assertion alone; preserve the recorded RED result from Tasks 1-3 if the implementation sequence already makes this immediately GREEN.
- [ ] Run the focused Playwright test and observe GREEN with no fixed delay longer than the client polling interval; the successful mutation/reload path should make it immediate.
- [ ] If `99+` is visually clipped in browser inspection, adjust only `.rail-nav-count` sizing in `apps/control-plane/app/globals.css`; otherwise leave CSS untouched.

### Task 5: Full verification and localhost handoff

**Files:**
- Verify all modified files; do not expand scope.

- [ ] Run `pnpm --filter @agentos/control-plane test`.
- [ ] Run `pnpm --filter @agentos/control-plane typecheck`.
- [ ] Run `pnpm --filter @agentos/control-plane lint`.
- [ ] Run `pnpm exec playwright test tests/e2e/scaffold.spec.ts`.
- [ ] Run `git diff --check` and inspect `git diff --stat` plus `git status --short` to confirm pre-existing dirty files remain untouched.
- [ ] Start or reuse a non-default-port control-plane server from this worktree, open the affected page, and give the user the localhost Inbox URL for explicit smoke-test approval.
- [ ] Do not commit, merge, push, stop shared services, or remove this worktree until the user explicitly authorizes the next action.
