# Login Chrome Gate

Status: Approved design
Date: 2026-08-21
Approach: session-gate the app shell so unauthenticated renders get a bare centered login stage and never fetch rail counts

## Context

The control plane root layout always paints `.app-shell` and `.app-rail`, including on `/login`. Session is already read there, but it only hides Sign Out. Nav destinations stay clickable (and bounce via `requirePageSession()`). `fetchRailCounts()` still runs, so a logged-out visitor can see live project and inbox counts.

Login is a gate, not a workspace. Extra chrome implies you are already inside.

## Goals

- Unauthenticated HTML never includes Primary navigation, the rail wordmark/footer, or status badges.
- Unauthenticated renders do not call `fetchRailCounts()`.
- The existing login card is centered on the canvas (bare stage). No wordmark header, no empty identity column.
- A signed-in operator hitting `/login` is redirected to the sanitized `returnTo` (default `/`).
- After sign-in, the current app shell is unchanged.

## Non-goals

- Do not restyle the login card, buttons, or copy.
- Do not add a marketing/split-screen login or a wordmark-only header.
- Do not introduce Next.js `(auth)` / `(app)` route groups. A path-based split would still run the app layout (and fetch counts) for a logged-out hit to a protected page before redirect.
- Do not change cookie issuance, GitHub OAuth, or the localhost bypass.
- Do not change `AppRailNav` items or protected-page `requirePageSession()` calls.
- Do not edit `.qoder/` wiki pages.

## Scope and implementation boundary

Lives in:

- `apps/control-plane/app/layout.tsx` — branch on `readPageSession()`: no session → `.auth-stage` around `{children}` (keep skip-link and `#main-content`); session → current `.app-shell`. Fetch counts only when session is present.
- `apps/control-plane/app/globals.css` — `.auth-stage` full-viewport flex center; zero `.auth-card` block margin inside it.
- `apps/control-plane/app/login/page.tsx` — if `readPageSession()` returns a session, `redirect(sanitizeReturnTo(returnTo))`.
- `apps/control-plane/src/auth/login-page.test.ts` and `tests/e2e/scaffold.spec.ts` — signed-in redirect; logged-out `/login` has no Primary navigation.

Must not touch: `apps/control-plane/src/ui/app-rail-nav.tsx`, auth cookie/OAuth/local routes, `requirePageSession()` on protected pages, generated wiki.
