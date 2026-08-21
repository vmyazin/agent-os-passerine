---
kind: frontend_style
name: CSS-in-CSS with Design Tokens and BEM-style Classes in Next.js Control Plane
category: frontend_style
scope:
    - '**'
source_files:
    - apps/control-plane/app/globals.css
    - apps/control-plane/app/layout.tsx
    - apps/control-plane/package.json
    - apps/control-plane/src/ui/inbox-view.tsx
    - apps/control-plane/src/ui/projects-table.tsx
    - apps/control-plane/src/ui/setup-wizard.tsx
    - apps/control-plane/src/ui/page-toolbar.tsx
    - apps/control-plane/src/ui/app-rail-nav.tsx
---

## What system/approach is used

The Agent OS monorepo has a single frontend: the **Next.js App Router** application under `apps/control-plane/`. Styling is done entirely with **plain CSS** (no Tailwind, no CSS-in-JS library, no component UI kit). The app imports a single global stylesheet at `apps/control-plane/app/globals.css` (~1275 lines) which defines the entire visual design — color tokens, typography, layout shells, page chrome, inbox mail-view, tables, buttons, status badges, and form controls.

There is no `tailwind.config.*`, no PostCSS config, and no third-party style dependency declared in `apps/control-plane/package.json` beyond React/Next/YAML/Zod. Components compose these global class names via the `className` attribute (e.g. `page-stack`, `app-shell`, `app-rail`, `inbox-page`, `metric-grid`, `status-badge-*`).

## Key files and packages

- `apps/control-plane/app/globals.css` — central stylesheet defining all design tokens and component styles.
- `apps/control-plane/app/layout.tsx` — root layout that wires the `.app-shell` / `.app-rail` / `.app-content` grid and injects the skip-link and wordmark.
- `apps/control-plane/src/ui/*.tsx` — presentational components (`projects-table.tsx`, `inbox-view.tsx`, `setup-wizard.tsx`, `page-toolbar.tsx`, `app-rail-nav.tsx`, etc.) that consume the global classes rather than defining their own.
- `apps/control-plane/package.json` — declares only `next`, `react`, `react-dom`; no styling framework dependency.

## Architecture and conventions

### Design tokens via CSS custom properties
All colors, surfaces, ink levels, status palettes, focus rings, and fonts are declared as `:root` variables at the top of `globals.css`:
- Surfaces: `--canvas-log`, `--surface-sheet`, `--surface-inset`
- Ink hierarchy: `--ink-command`, `--ink-secondary`, `--ink-muted`, `--code-ink`
- Lines: `--line-soft`, `--line-emphasis`
- Accent: `--signal-violet`, `--signal-violet-dark`, `--focus-ring`
- Status palette: `--status-neutral-*`, `--status-success-*`, `--status-waiting-*`, `--status-danger-*`
- Danger: `--danger-surface`, `--danger-ink`
- Timeline: `--timeline-rail`

Typography uses the Inter/system stack and `clamp()` for fluid type scales on headings and hero text.

### Layout model
A fixed two-column shell drives the app chrome:
- `.app-shell` — CSS Grid with a min-width rail (`minmax(11rem, 14rem)`) + content area.
- `.app-rail` — left sidebar containing nav links, status badge, sign-out button, and footer.
- `.app-content` / `.app-content-scroll` — scrollable main area; when an inbox page is present, `:has(.inbox-page)` reflows the content into a split-pane mailbox layout.

### Component-class naming
Classes follow a flat, descriptive BEM-like scheme scoped to the app (no CSS modules, no CSS-in-JS):
- Shell/chrome: `.app-shell`, `.app-rail`, `.app-content`, `.app-status-bar`
- Page scaffolding: `.page-heading`, `.page-stack`, `.page-toolbar`, `.hero`, `.empty-state`
- Data display: `.metric-grid`, `.projects-table`, `.run-list`, `.metadata`
- Inbox: `.inbox-page`, `.mailbox`, `.inbox-queue`, `.inbox-row`, `.inbox-reading-pane`, `.inbox-message-*`, `.inbox-thread-*`
- Controls: `.button`, `button.secondary`, `textarea`, `.notice.error`
- Status badges: `.status-badge-{attention|neutral}`, `.status-{running|succeeded|waiting|failed|cancelled}`

Components in `src/ui/` are thin presentational wrappers around these classes plus data-fetching/view-model logic (e.g. `inbox-view-model.ts`, `rail-status-model.ts`, `project-count-signal.ts`).

### Responsive strategy
Responsive behavior is achieved through:
- Fluid typography via `clamp()` on `h1`, hero copy, metric values.
- CSS Grid auto-sizing (`minmax`, `fr`) for the rail/content split and inbox split pane.
- `clamp()` padding/margins on hero and empty states.
- No media-query breakpoints were found in `globals.css`; the layout adapts primarily through flexible grid and fluid sizing.

### Accessibility conventions
- Skip link (`.skip-link`) for keyboard navigation.
- Focus ring defined by `--focus-ring` applied to `a:focus-visible`, `button:focus-visible`, `textarea:focus-visible`, and inbox rows.
- ARIA attributes used on interactive elements (e.g. `aria-current="page"`, `aria-pressed`, `role="alert"`, `aria-live="polite"`).
- Semantic HTML structure (`main`, `aside`, `nav`, `section`, `dl/dt/dd` for metadata).

## Conventions and constraints

- **Single source of truth**: All visual design lives in `apps/control-plane/app/globals.css`; there are no per-component CSS files or CSS-in-JS stylesheets.
- **No utility-first CSS**: Components do not use Tailwind/utility classes; they reference semantic class names defined centrally.
- **Design tokens first**: New colors, surfaces, or status variants should be added as `--var` entries in `:root` before being consumed by new classes.
- **Class naming**: Use descriptive, app-scoped class names (no generic element selectors beyond resets); compound modifiers use suffixes like `-attention`, `-neutral`, `-secondary`, `-error`.
- **Inbox-specific layout override**: The inbox page opt-in via the `.inbox-page` class triggers a full-height split-pane layout using `:has(.inbox-page)` — this pattern should be replicated if other pages need similar overrides.
- **No theme switching**: Only a light `color-scheme` is set; no dark-mode token set was found.