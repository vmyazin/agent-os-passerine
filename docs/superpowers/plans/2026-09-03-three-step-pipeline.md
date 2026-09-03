# Three-Step Pipeline — implementation plan

Spec: [2026-09-03-three-step-pipeline-design.md](../specs/2026-09-03-three-step-pipeline-design.md)
Branch: `feat/local-direct-runtime`

## File map

Modify:

- `packages/adapters/src/trigger/types.ts:51-62` — `FeatureWorkflowRoles`
- `packages/adapters/src/trigger/production-composition.ts:32-60, 165-175` —
  required vs optional roles, environment distinctness
- `packages/adapters/src/trigger/schemas.ts` — `implementation-request-v1`
  input carries spec/DoD, plan optional (only if a schema exists for it)
- `packages/adapters/src/trigger/workflow.ts:2162-2330` — planning optional,
  implementation request, review moved after verification and made advisory,
  fix loop removed; `:2395-2415` verifier call drops `review`
- `packages/adapters/src/trigger/verifier.ts:53-60` — review no longer parsed
  or required
- `packages/adapters/src/kimi/provider.ts:436-500` — no-loop verification
  session
- `apps/control-plane/app/runs/[id]/page.tsx` — review notes for any run
- `agentos/ld-smoke.yaml`, `agentos/passerine.yaml`, `agentos/example.yaml`
- `docs/architecture/durable-feature-workflow.md`, `docs/progress.md`
- tests: `workflow.test.ts`, `production-composition.test.ts`,
  `verifier.test.ts`, `kimi/provider.test.ts`

**Do not modify:** `trigger/outbox.ts`, `trigger/checkpoint-store.ts`,
`trigger/postgres-checkpoint-store.ts`, `trigger/workflow-budget.ts`,
`managed-agents/**`, `github/**`, `local-git/**`, `drizzle/**`.

## Tasks

- [x] **1. Optional roles.** `types.ts`, `production-composition.ts` + test.
      Verify: `pnpm --filter @agentos/adapters exec vitest run src/trigger/production-composition.test.ts`
- [x] **2. Verifier without review.** `verifier.ts` + test.
      Verify: `... vitest run src/trigger/verifier.test.ts`
- [x] **3. Workflow sequence.** `workflow.ts`, `schemas.ts` + tests: planning
      optional, review after verification and advisory, fix loop removed.
      Verify: `... vitest run src/trigger/workflow.test.ts`
- [x] **4. Zero-cost verification on the process runtime.** `kimi/provider.ts` + test. Verify: `... vitest run src/kimi/provider.test.ts`
- [x] **5. Review notes on the run page.** `page.tsx`.
      Verify: `pnpm --filter @agentos/control-plane exec vitest run`
- [x] **6. Configs and docs.** Three YAML files, runbook, progress.
      Verify: `pnpm typecheck && pnpm lint`
- [ ] **7. Exit gate.** Re-apply `ld-smoke.yaml`, run "Serve a health
      endpoint" on the local executor. Verify: run succeeds, branch published,
      review finding visible as a note.
