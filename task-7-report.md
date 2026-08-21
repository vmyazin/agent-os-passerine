# Task 7 Report: Approval TTL and Execution Deadline

Implemented separated timeouts for approval and execution, and ensured the execution clock starts only after approval is consumed.

## Changes

### `packages/adapters/src/trigger/types.ts`
- Added `approvalTtlMs: 24 * 60 * 60 * 1_000` to `FEATURE_WORKFLOW_DEFAULTS`.

### `packages/adapters/src/trigger/workflow.ts`
- Updated `triggerWaitDuration` to bound by `approvalTtlMs`.
- Updated `run()` to:
    - Use `approvalTtlMs` for the approval's `expiresAt` and the waitpoint timeout.
    - Fetch the approval after it is consumed to retrieve the actual `consumedAt` timestamp.
    - Update `deadlineMs` to `consumedAt + workflowTimeoutMs`, ensuring the 1-hour execution limit starts after approval.
- Fixed a scoping issue with `deadlineMs` by changing it from `const` to `let` and updating it after approval.

### `packages/adapters/src/trigger/workflow.test.ts`
- Updated the waitpoint timeout expectation to `86400s` (24 hours).
- Added a regression test `starts the execution deadline at approval consume, not run creation` which verifies that a run created well before approval can still succeed if it completes within the timeout after approval.

## Verification Results
- Ran `pnpm exec vitest run src/trigger/workflow.test.ts` in `packages/adapters`.
- All 22 tests passed, including the new regression test.

DONE
