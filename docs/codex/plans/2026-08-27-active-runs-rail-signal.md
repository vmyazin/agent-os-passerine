# Active runs rail signal implementation plan

## File map

- `apps/control-plane/src/ui/active-run-status.ts` — canonical in-flight status predicate.
- `apps/control-plane/src/ui/rail-counts.ts` — exact active count in the server layout seed.
- `apps/control-plane/app/api/runs/active-count/route.ts` — authenticated live-count endpoint.
- `apps/control-plane/src/ui/active-run-count-client.ts` — validated fail-soft polling and accessible presentation.
- `apps/control-plane/src/ui/app-rail-nav.tsx` and `apps/control-plane/app/layout.tsx` — render and seed the signal.
- `apps/control-plane/app/globals.css` — inline spinner alignment.
- Adjacent unit tests and `tests/e2e/scaffold.spec.ts` — behavior and accessibility coverage.

## Do not modify

- Workflow lifecycle or persistence code.
- Workspace status bar semantics.
- The unrelated untracked `agentos/agent-os.yaml`.

## Tasks

- [x] Add failing tests for active-status classification, count presentation, polling, and rail accessibility.
- [x] Implement exact server counting and the authenticated endpoint.
- [x] Implement live client polling and the Runs rail count/spinner.
- [x] Run focused tests, full checks, and a current-server visual smoke test.
