# Live Inbox Rail Count Design

Status: Approved design

Date: 2026-08-27

## Follow-up decision — exact totals and preserved client lifecycle

Review on 2026-08-27 supersedes two implementation details below. The count
query must paginate every run and every pending item page so the exact ARIA
label never saturates at repository list limits. Successful Inbox mutations
must publish the invalidation and call `router.refresh()` rather than reload
the document, so the mounted rail subscription can finish its request while
the server-rendered Inbox content refreshes.

## Context

The primary side navigation already renders an Inbox count seeded by the root
server layout. That count represents pending approvals plus unanswered inbox
messages, but it changes only after a server navigation. Background workflow
activity can therefore create a new item while the visible navigation remains
stale.

## Goals

- Keep the Inbox navigation count current without requiring navigation or a
  manual reload.
- Preserve the existing meaning: pending approvals plus messages whose status
  is `pending`.
- Refresh immediately after an approval, rejection, or inbox reply performed in
  the current browser.
- Keep the badge accessible, compact, and fail-soft.

## Non-goals

- Do not add read/unread or per-user seen state.
- Do not add WebSockets, Server-Sent Events, Trigger.dev realtime
  subscriptions, notifications, or background push infrastructure.
- Do not change Inbox ordering, filters, item rendering, or approval semantics.
- Do not change persistence schemas or repository interfaces.
- Do not replace native navigation anchors or introduce a client data library.

## Scope and implementation boundary

The change lives in the control-plane UI and HTTP surface:

- `apps/control-plane/src/ui/app-rail-nav.tsx` owns the live count state and
  refresh lifecycle.
- `apps/control-plane/src/application/control-plane-service.ts` owns exact,
  fully paginated attention counting over the existing repository interface.
- A small client helper in `apps/control-plane/src/ui/` owns count fetching and
  the same-tab invalidation signal.
- A dedicated authenticated route under
  `apps/control-plane/app/api/inbox/count/route.ts` returns only the current
  attention count.
- The existing `countInboxAttention` function remains the single definition of
  count semantics.
- Existing Inbox action code publishes an invalidation after a successful
  approval, rejection, or reply.
- Existing rail CSS is extended only as needed for the capped display value.

The change must not modify workflow execution, Trigger.dev tasks, artifact
storage, persistence adapters, database migrations, authentication rules, or
the full `/api/inbox` response.

## Chosen approach

Add a dedicated count endpoint and a small client-side refresh loop. This avoids
polling the full Inbox payload and avoids introducing durable push
infrastructure for a single integer.

The alternatives rejected are:

1. Poll `/api/inbox`. This avoids a route but repeatedly loads full message and
   approval projections, including data the navigation never renders.
2. Add server push. This provides lower latency but adds connection lifecycle,
   reconnect, authorization, and deployment concerns that are disproportionate
   to the requested badge.

## Count semantics

The count is:

```text
pending approval count + pending message count
```

Resolved approvals and replied messages are excluded. Opening the Inbox does
not clear the count. A zero count hides the badge.

The visible badge renders the exact value from 1 through 99 and `99+` above
that. The accessible label retains the exact value, for example: `Inbox, 143
items need attention`.

## Data flow

1. The root layout continues to fetch and render the initial server count.
2. `AppRailNav` seeds local state from that prop, preventing a hydration
   placeholder or count flicker.
3. While the document is visible, the client requests `/api/inbox/count` every
   15 seconds.
4. Window focus and a transition from hidden to visible trigger an immediate
   refresh.
5. A successful approval, rejection, or reply publishes a same-tab
   invalidation signal. The rail receives it and refreshes immediately.
6. A later server render re-seeds the client state from the authoritative
   layout prop.

Only one request may be active at a time. Unmounting aborts an active request
and removes timers and listeners.

## Endpoint contract

`GET /api/inbox/count` uses the existing API authentication boundary and
returns:

```json
{"count": 3}
```

The route obtains messages and pending approvals through the control-plane
service and computes the result with `countInboxAttention`. The output count is
a non-negative safe integer.

## Error handling

- A failed initial server count remains fail-soft as it is today.
- A failed client refresh keeps the last successfully rendered count.
- Polling continues after transient failures; the badge does not show an error
  state or reset to zero.
- An unauthenticated count request follows the existing API authentication
  response and does not leak Inbox state.
- A malformed successful response is ignored.

## Accessibility and interaction

- The Inbox link remains a native anchor and retains its active-page state.
- The count remains inside the link, so it does not create another focus stop.
- The link receives an exact accessible label when the count is positive.
- Badge updates do not use an ARIA live region; background count changes must
  not interrupt screen-reader users.
- The badge remains hidden when the count is zero.

## Test-first coverage

1. Route test: authenticated requests return the sum of pending approvals and
   pending messages; resolved items are excluded.
2. Route test: authentication and service failures retain the existing API
   error behavior.
3. Navigation rendering test: zero hides the badge, positive counts render, and
   values above 99 display `99+` while keeping the exact accessible label.
4. Client refresh test: the initial server value is retained on fetch failure,
   and a successful refresh updates it.
5. Client refresh test: focus, visibility restoration, and the same-tab
   invalidation signal request an immediate refresh without overlapping an
   active request.
6. Browser regression: a pending Inbox item is reflected in the side navigation
   and the link opens `/inbox`.

## Acceptance criteria

- A background-created pending approval or unanswered message appears in the
  Inbox rail count within 15 seconds while the page is visible.
- Returning focus to the app refreshes the count immediately.
- Successfully resolving an Inbox item updates the count immediately without a
  page navigation.
- The badge is absent at zero, exact through 99, and visually capped at `99+`.
- The accessible label always communicates the exact number of items needing
  attention.
- Refresh failures never remove or reset the last known count.
- No persistence, workflow, or realtime infrastructure is added.
