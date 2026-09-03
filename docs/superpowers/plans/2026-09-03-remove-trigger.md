# Remove Trigger.dev — implementation plan

Spec: [2026-09-03-remove-trigger-design.md](../specs/2026-09-03-remove-trigger-design.md)
Branch: `feat/local-direct-runtime`

## File map

Move types into, then modify:

- `packages/adapters/src/trigger/types.ts` — receives
  `FeatureWorkflowTaskHandler`, `GoalWorkflowTaskHandler`,
  `TriggerWorkflowDispatcher`, `TriggerApprovalWaiter`

Delete:

- `packages/adapters/src/trigger/task.ts`, `goal-task.ts`,
  `trigger-adapter.ts`, `trigger-adapter.test.ts`, `task-source.test.ts`
- `trigger.config.ts`
- `packages/adapters/scripts/trigger-dispatch-smoke.mjs`

Modify:

- `packages/adapters/src/trigger/index.ts` — drop deleted exports
- `packages/adapters/src/trigger/outbox.ts` — import port from types;
  `isExecutorUnavailable` recognises `LOST`/`FAILED`
- `packages/adapters/src/trigger/production-handler.ts`,
  `production-composition.ts`, `goal-production-composition.ts` — imports;
  the feature composition's `approval` is supplied by the caller
- `packages/adapters/src/local-direct/{composition,dispatcher,approval-waiter}.ts`
  — imports; dispatcher returns the local status vocabulary
- `apps/control-plane/src/application/runtime.ts` — delete the Trigger branch
  and `executorFromEnv`; `workflowDispatchFromEnv` returns the local outbox
- `apps/control-plane/src/application/setup-readiness.ts` — drop the
  `dispatch` group and the executor field
- `apps/control-plane/src/ui/dispatch-diagnostics-model.ts` — drop
  Trigger-only statuses
- `apps/control-plane/src/ui/undispatched-run-notice.tsx` — one notice
- `apps/control-plane/src/ui/dispatch-stall.ts` — wording
- `apps/control-plane/app/runs/[id]/page.tsx` — drop the executor prop
- `package.json` (root) — deps and scripts; `packages/adapters/package.json` —
  smoke script
- `.env.example`, `docs/architecture/durable-feature-workflow.md`,
  `docs/progress.md`, `README.md`, `AGENTS.md` if it names Trigger

**Do not modify:** the workflow engine (`workflow.ts`, `goal-workflow.ts`),
the checkpoint stores, `workflow-budget.ts`, sealing, `verifier.ts`, the
publishers, `managed-agents/**`, `github/**`, `local-git/**`, `drizzle/**`,
`vercel.json` crons.

## Tasks

- [ ] **1. Move the ports.** Types into `types.ts`; update importers so the
      three SDK files have no remaining dependents. Verify: `pnpm typecheck`
- [ ] **2. Delete the SDK files and config.** The three modules, their tests,
      `trigger.config.ts`, the smoke script. Verify: `pnpm typecheck && pnpm --filter @agentos/adapters exec vitest run`
- [ ] **3. Local status vocabulary.** Dispatcher returns `EXECUTING`/
      `COMPLETED`/`FAILED`/`LOST`; outbox recognises `LOST`/`FAILED`;
      diagnostics drop Trigger-only branches. Verify:
      `pnpm --filter @agentos/adapters exec vitest run src/trigger/outbox.test.ts src/local-direct/`
- [ ] **4. One executor in the control plane.** Delete the Trigger branch,
      `executorFromEnv`, the readiness `dispatch` group, the notice variant.
      Verify: `pnpm --filter @agentos/control-plane exec vitest run`
- [ ] **5. Dependencies and environment.** Remove the two devDependencies and
      three scripts; strip `TRIGGER_*` from `.env.example`. Verify:
      `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint`
- [ ] **6. Docs.** Runbook, progress, README, and the local-direct spec's
      executor section. Verify: `pnpm format:check` on changed files
- [ ] **7. Live gate.** One feature run end to end on the fixture project.
