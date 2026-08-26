# Clickable Projects Metric Card

Status: Approved design

## Context

The dashboard shows Projects, Recent runs, and Budget as three inline metric
articles. The Projects metric reports the project count but does not navigate to
the project directory, even though the primary navigation and project table use
ordinary links for the same destination.

The metric markup is not unique to the dashboard. The project-detail page
duplicates the same label, value, and detail structure for Runs, Latest
revision, and Budget. Making only the dashboard Projects article clickable
would add one-off interaction to markup that already has a stable reusable
shape.

## Goals

- Make the dashboard Projects metric a native link to `/projects`.
- Extract the repeated metric article into a reusable `MetricCard` primitive.
- Use the primitive for all six existing dashboard and project-detail metrics.
- Preserve the current metric layout, appearance, responsive stacking, and
  server-rendered behavior.
- Preserve native link behavior, including keyboard activation, open-in-new-tab
  support, and the existing focus-visible treatment.

## Non-goals

- Making Recent runs, Budget, Runs, or Latest revision clickable.
- Adding client state, event handlers, router calls, or JavaScript navigation.
- Adding Radix, `next/link`, a generic polymorphic Card, or a slot/as-child API.
- Changing project counts, data fetching, route definitions, authentication, or
  page projections.
- Redesigning the dashboard, changing card copy, or introducing a new visual
  vocabulary.
- Refactoring unrelated surfaces that happen to use bordered panels or cards.

## Scope and implementation boundary

The reusable primitive lives in
`apps/control-plane/src/ui/components.ts`, alongside the existing small shared
`RunStatusBadge` and `EmptyState` primitives. Its call sites are limited to the
metric grids in `apps/control-plane/app/page.tsx` and
`apps/control-plane/app/projects/[id]/page.tsx`.

Metric styling remains in `apps/control-plane/app/globals.css`, but moves from
the element-coupled `.metric-grid article` selector to explicit metric-card
classes. Unit coverage belongs in
`apps/control-plane/src/ui/components.test.ts`; the navigation scenario belongs
in `tests/e2e/scaffold.spec.ts`.

Do not modify application services, persistence, API routes, route paths,
authentication, project projections, import behavior, workflow execution,
source ingestion, publication, prompts, or generated documentation.

## Approved component design

### Public contract

`MetricCard` accepts:

- `label: string` — the short metric name.
- `value: ReactNode` — the prominent value.
- `detail: ReactNode` — the supporting line.
- `href?: string` — when present, the destination for a native full-card link.

The component does not accept click handlers, arbitrary element selection, or
visual variants. Those APIs are unnecessary for the six approved call sites and
would weaken the distinction between navigation and static summary content.

### Semantic structure

Every `MetricCard` retains an outer `<article className="metric-card">`. This
keeps each summary item as a self-contained article regardless of whether it is
interactive.

Inside the article, the component renders the same label, value, and detail
content in one shared body:

- When `href` is present, the body is a native `<a>` with both
  `metric-card-body` and `metric-card-link` classes.
- When `href` is absent, the body is a noninteractive `<div>` with the
  `metric-card-body` class.

The anchor fills the card's content area, so the visible card is the click
target. Its accessible name comes from the visible label, value, and detail; no
replacement `aria-label` hides that information. Native anchor semantics supply
keyboard activation and browser link actions without client code.

### Call sites

Replace all six existing inline metric articles with `MetricCard`:

- Dashboard Projects: `href="/projects"`.
- Dashboard Recent runs: no `href`.
- Dashboard Budget: no `href`.
- Project-detail Runs: no `href`.
- Project-detail Latest revision: no `href`.
- Project-detail Budget: no `href`.

Only the dashboard Projects metric navigates in this slice. Replacing all six
articles demonstrates that the primitive is genuinely shared and prevents the
static cards from drifting to a different DOM or visual structure.

## Styling

- `.metric-card` owns the existing border, radius, background, and outer grid
  item behavior.
- `.metric-card-body` owns the existing internal grid, gap, minimum height,
  alignment, and padding so linked and unlinked cards have identical geometry.
- `.metric-card-link` inherits text color, removes link underlining, fills the
  available card area, and adds only a subtle hover surface change.
- The existing `.metric-label`, `.metric-value`, and `.metric-detail` rules
  remain the content typography contract.
- The existing `.metric-grid` responsive rule continues to stack metrics at the
  same breakpoint.
- The global `a:focus-visible` rule remains authoritative. The metric link must
  not suppress or replace its visible outline.

The default and hover surfaces must continue to use the existing design tokens.
No new colors, shadows, animation, or elevation tier are introduced.

## Data flow and failure behavior

The home page continues to fetch runs and projects on the server and passes the
already-computed project count into `MetricCard`. Activating the Projects anchor
performs a normal GET of `/projects`; the destination page retains its current
authentication and data-loading behavior.

There is no new asynchronous state or component-specific failure mode. If the
destination request fails, the existing Next.js page error behavior applies.

## Verification

Tests are added before production changes:

1. A static-render unit test proves that a metric without `href` renders an
   article with its label, value, and detail and does not render an anchor.
2. A static-render unit test proves that a metric with `href="/projects"`
   renders the same content inside a full-card native anchor with the correct
   destination.
3. A Playwright test loads `/`, locates the Projects metric as a link by its
   accessible name, focuses it, presses Enter, and verifies navigation to
   `/projects` and the Projects page heading.

Existing dashboard, project-directory, project-detail, and responsive tests
must remain green. Final verification includes the control-plane unit tests,
typecheck, lint, build, the relevant Playwright scenario, and a dashboard smoke
test on the assigned non-default port.

## Acceptance criteria

- The entire visible dashboard Projects metric is a native link to `/projects`.
- Keyboard focus is visible and Enter activates the link.
- All six current metrics render through one reusable `MetricCard` primitive.
- The other five metrics remain noninteractive.
- Linked and unlinked cards retain the current layout and responsive behavior.
- No production or test behavior outside the files named in the scope boundary
  changes.

## Decision record

The approved optional-`href` primitive was chosen over separate static and link
components because both variants share one semantic article and one content
shape. It was chosen over a generic polymorphic Card because the repository has
no broader polymorphic-card convention or second non-metric use case to justify
that API surface.
