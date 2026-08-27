# Active runs rail signal

Status: Approved design

## Context

The primary rail shows project and Inbox counts, but Runs has no at-a-glance indication that workers are progressing. Run badges already distinguish in-flight `pending` and `running` states from `waiting`, which is blocked on the operator and must not imply motion.

## Goals

- Show the exact active run count on the Runs navigation item.
- Define active as `pending` plus `running`; exclude waiting and terminal runs.
- Place the existing reduced-motion-safe spinner immediately after the word Runs whenever the active count is positive.
- Keep the value live while the app remains open, failing soft on transient requests.
- Preserve the count pill at the rail edge and provide an exact accessible label.

## Non-goals

- Do not count waiting, succeeded, failed, or cancelled runs.
- Do not change the workspace status bar or individual run status semantics.
- Do not add model-provider or workflow-specific activity states.
- Do not animate the numeric badge.

## Scope and implementation boundary

- Server counting lives in `apps/control-plane/src/ui/rail-counts.ts` using existing exact run-count service methods.
- The authenticated read endpoint lives at `apps/control-plane/app/api/runs/active-count/route.ts`.
- Client polling and presentation live in a dedicated UI module and `AppRailNav`; it must preserve the last known count when requests fail and pause while the document is hidden.
- Styling reuses `.status-spinner` and `.rail-nav-count`; only minimal rail-label layout CSS may be added.
- The change must not modify workflow state transitions, persistence schemas, or run records.

## Acceptance criteria

- Zero active runs renders plain “Runs” with no spinner or count.
- One or more pending/running runs renders a spinner immediately after “Runs” and the active count in the existing right-edge pill.
- Waiting and terminal runs do not contribute to the count.
- Screen readers receive “Runs, N active runs” while the spinner remains decorative.
- The count refreshes on mount, focus, visibility restoration, and a bounded interval.
