# Task 6 Report: Frozen Acceptance Tests on Spec Approval

## Implementation Summary

Implemented the rendering of frozen acceptance tests in the spec approval inbox.

### Changes

- **Contracts**: Extended `approvalSchema.summary` in `apps/control-plane/src/http/contracts.ts` to include `acceptanceTests` array.
- **Service Type**: Updated `ApprovalSummary` interface in `apps/control-plane/src/application/control-plane-service.ts` to include `acceptanceTests`.
- **Service Logic**: Modified `approvalSummary()` in `ControlPlaneService` to parse `acceptanceTests` from the Definition of Done (DoD) artifact and include them in the approval summary. Tests are bounded at 8,000 characters and a maximum of 20 files.
- **UI Rendering**: Updated `ApprovalMessage` in `apps/control-plane/src/ui/inbox-view.tsx` to render the list of acceptance tests with their paths and file contents.
- **Testing**: Added a comprehensive test case in `apps/control-plane/src/application/control-plane-service.test.ts` that verifies the end-to-end flow from artifact creation to inclusion of acceptance tests in the approval summary.

## Verification Results

### Automated Tests
Ran the control-plane service tests and contract schema tests:
`pnpm --filter @agentos/control-plane test -- src/application/control-plane-service.test.ts src/http/contracts.ts`

**Result**: PASS (182 tests passed)

### Fixes during implementation
- Fixed a validation error in the test suite where colons were used in persistence IDs, which are not allowed in artifact storage segments.
- Fixed incorrect usage of `createArtifact` in the repository during tests, which bypassed the artifact store port.
