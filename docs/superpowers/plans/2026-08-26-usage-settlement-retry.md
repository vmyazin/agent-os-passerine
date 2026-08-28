# Usage Settlement Retry Implementation Plan

## File map

- `packages/adapters/src/trigger/workflow.test.ts`: add response-loss retry and permanent fail-fast regressions near the existing transient retry coverage.
- `packages/adapters/src/trigger/workflow.ts`: add bounded nested-cause classification and an immutable, two-attempt usage append.

Do not modify persistence schemas, migrations, repository interfaces, pricing, Trigger configuration, runtime adapters, control-plane routes, or UI files.

## Tasks

- [x] Add a test where the first usage append commits and throws a nested transient transport error; assert success, identical payload replay, and no extra runtime session.
  - Verify: `pnpm --filter @agentos/adapters test -- workflow.test.ts`
- [x] Add a test where usage append throws a permanent error; assert one append attempt and visible run failure.
  - Verify: `pnpm --filter @agentos/adapters test -- workflow.test.ts`
- [x] Implement one immutable usage draft plus a maximum of two append attempts for transient errors.
  - Verify: `pnpm --filter @agentos/adapters test -- workflow.test.ts`
- [x] Persist the pending step before fallible preparation so zero-usage settlement cannot violate the step foreign key or mask the primary error.
  - Verify: `pnpm --filter @agentos/adapters test -- workflow.test.ts`
- [x] Run adapters tests, repository typecheck, and lint.
  - Verify: `pnpm --filter @agentos/adapters test && pnpm typecheck && pnpm lint`
- [ ] Retry the live `Start Work` feature as a fresh Agent OS run and confirm it reaches the approval gate.
  - Verify: inspect the fresh run, step attempts, usage rows, and approval record.
