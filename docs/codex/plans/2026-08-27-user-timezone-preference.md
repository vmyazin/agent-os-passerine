# User timezone preference implementation plan

## File map

- `packages/core/src/persistence.ts: persistence records and DomainRepository` — add the typed user-preferences contract.
- `packages/adapters/src/persistence/{schema,row-mapping,in-memory,neon-repository}.ts` — add table mapping and repository implementations.
- `drizzle/0024_*.sql` and `drizzle/meta/*` — generated migration artifacts.
- `apps/control-plane/src/application/control-plane-service.ts` — authenticated-identity-neutral preference methods.
- `apps/control-plane/app/api/preferences/time-zone/route.ts` — same-origin authenticated mutation.
- `apps/control-plane/src/ui/{time-zone,format-timestamp,time-of-day-greeting}.ts` — validation, options, and shared formatting.
- `apps/control-plane/src/ui/time-zone-selector.tsx` and `apps/control-plane/app/configuration/page.tsx` — selector and preview.
- Timestamp-rendering pages/components under `apps/control-plane/app/` and `apps/control-plane/src/ui/` — pass and consume the resolved timezone.
- Focused tests adjacent to each layer plus scaffold browser coverage.

## Do not modify

- Project YAML configuration schema and revisions.
- Workflow execution, model-provider, budget, or publication code.
- Authentication cookie/session formats.
- The unrelated untracked `agentos/agent-os.yaml`.

## Tasks

- [x] Add persistence and schema tests that prove per-login upsert/read behavior and database constraints. Verify with `pnpm --filter @agentos/adapters test`.
- [x] Add API and service tests for valid save, invalid timezone rejection, authentication, and identity isolation. Verify with the focused control-plane Vitest files.
- [x] Add formatter and selector rendering tests, including a timestamp that crosses a calendar date between UTC and America/Sao_Paulo. Verify with focused UI tests.
- [x] Implement the preferences record, migration, repositories, service, and authenticated route.
- [x] Implement the Operator time selector and shared preference resolver.
- [x] Replace all absolute-time rendering and greeting call sites with shared timezone-aware formatting; keep elapsed-time labels unchanged.
- [x] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, the production build, and a browser smoke test on the existing local server.
