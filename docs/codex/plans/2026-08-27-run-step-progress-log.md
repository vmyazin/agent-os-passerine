# Run step progress log implementation plan

## File map

- `packages/adapters/src/trigger/workflow.ts:consumeEvents,runAgentStep` — deterministic sanitized progress emission.
- `packages/adapters/src/trigger/workflow.test.ts:durable feature workflow tests` — event sequence, retry, and non-disclosure coverage.
- `apps/control-plane/src/application/control-plane-service.ts:RunProjection,projectEventPayload,project` — step progress DTO and grouping.
- `apps/control-plane/src/application/control-plane-service.test.ts:run projection tests` — grouping, ordering, and redaction coverage.
- `apps/control-plane/src/ui/run-step-timeline.ts` and `components.test.ts` — expandable server-rendered step component and resting/expanded markup contract.
- `apps/control-plane/app/runs/[id]/page.tsx:Steps section` — component integration.
- `apps/control-plane/app/globals.css:timeline styles` — flight-recorder row styling and mobile behavior.

## Do not modify

- Database schema or migrations.
- Runtime provider payload contracts.
- Retry counts, deadlines, budgets, approvals, or publication behavior.
- The unrelated `agentos/agent-os.yaml` file.

## Tasks

- [x] Add failing workflow tests for lifecycle events and provider-payload non-disclosure; verify with `pnpm --filter @agentos/adapters test -- workflow.test.ts`.
- [x] Add failing projection and component tests; verify with `pnpm --filter @agentos/control-plane test -- control-plane-service.test.ts components.test.ts`.
- [x] Implement deterministic progress emission and make the adapter tests green.
- [x] Implement the bounded step projection and expandable UI; make the control-plane tests green.
- [x] Run adapter and control-plane tests, repository typecheck, lint, and build.
- [x] Verify the collapsed/expanded interaction on the existing local server. The pre-existing failed run correctly uses the historical-data fallback because it predates progress emission.
