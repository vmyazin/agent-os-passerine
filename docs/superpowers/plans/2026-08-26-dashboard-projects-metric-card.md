# Clickable Projects Metric Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard Projects metric a keyboard-accessible native link to `/projects` while extracting all six existing metrics into one reusable `MetricCard` primitive.

**Architecture:** Add the small server-renderable primitive to the existing shared UI component module. The primitive always owns outer article semantics and conditionally renders one shared body as either a native anchor or a noninteractive wrapper; pages only supply content and the Projects destination. Explicit CSS classes preserve the current geometry and responsive grid without client state or routing changes.

**Tech Stack:** React 19 server rendering, Next.js 16 App Router, TypeScript 6, global CSS design tokens, Vitest static-markup tests, Playwright end-to-end tests.

---

## File map

- `apps/control-plane/src/ui/components.ts:1-58` — add the shared `MetricCard` contract and semantic renderer beside the existing small UI primitives.
- `apps/control-plane/src/ui/components.test.ts:1-27` — prove linked and unlinked server-rendered markup before implementation.
- `apps/control-plane/app/page.tsx:1-51` — replace the three dashboard metric articles and give only Projects `href="/projects"`.
- `apps/control-plane/app/projects/[id]/page.tsx:1-130` — import the primitive and replace the three static project-detail metric articles.
- `apps/control-plane/app/globals.css:366-411` — replace the element-coupled card selector with explicit primitive/body/link classes while retaining typography and responsive behavior.
- `tests/e2e/scaffold.spec.ts:49-81` — add native keyboard navigation coverage from the dashboard Projects metric.

## Do not modify

- Application services, persistence, API routes, authentication, project projections, data fetching, or route definitions.
- Any metric copy, count calculation, project-detail computation, or responsive breakpoint.
- Import behavior, workflow execution, source ingestion, publication, prompts, generated documentation, or `agentos/agent-os.yaml`.
- Radix dependencies, `next/link`, client components, click handlers, router calls, a generic polymorphic Card, or slot/as-child APIs.

## Worktree setup

- [ ] **Step 1: Install isolated dependencies and required local typecheck files**

Run from `/Users/vm/dev/@team-zork/agent-os-passerine/.worktrees/dashboard-projects-metric-link`:

```bash
CI=true pnpm install --frozen-lockfile
pnpm turbo run build --filter=@agentos/core --filter=@agentos/adapters
cp ../../.env.local .env.local
ln -s ../../.env.local apps/control-plane/.env.local
cp ../../apps/control-plane/next-env.d.ts apps/control-plane/
```

Expected: installation and both package builds succeed; the copied/symlinked environment files remain gitignored.

### Task 1: Add failing primitive and navigation tests

**Files:**

- Modify: `apps/control-plane/src/ui/components.test.ts:1-27`
- Modify: `tests/e2e/scaffold.spec.ts:49-81`

- [ ] **Step 1: Add both static-render primitive tests**

Update the component import and add these cases inside the existing describe block:

```ts
import { EmptyState, MetricCard, RunStatusBadge } from './components';

it('renders a noninteractive metric card with article semantics', () => {
  const markup = renderToStaticMarkup(
    createElement(MetricCard, {
      label: 'Budget',
      value: '—',
      detail: 'Not configured',
    }),
  );

  expect(markup).toContain('<article class="metric-card">');
  expect(markup).toContain('class="metric-card-body"');
  expect(markup).toContain('Budget');
  expect(markup).toContain('Not configured');
  expect(markup).not.toContain('<a');
});

it('renders a native full-card metric link when href is present', () => {
  const markup = renderToStaticMarkup(
    createElement(MetricCard, {
      label: 'Projects',
      value: 1,
      detail: '1 project',
      href: '/projects',
    }),
  );

  expect(markup).toContain('<article class="metric-card">');
  expect(markup).toContain('class="metric-card-body metric-card-link"');
  expect(markup).toContain('href="/projects"');
  expect(markup).toContain('Projects');
  expect(markup).toContain('1 project');
});
```

- [ ] **Step 2: Run the unit test and observe the red state**

Run:

```bash
pnpm --filter @agentos/control-plane test -- components.test.ts
```

Expected: FAIL because `MetricCard` is not exported from `components.ts`. Do not change production code yet.

- [ ] **Step 3: Add the dashboard keyboard-navigation regression test**

Add this Playwright test after the existing accessible-dashboard test:

```ts
test('operator can open projects from the metric card by keyboard', async ({
  page,
}) => {
  await page.goto('/');

  const summary = page.getByRole('region', { name: 'Workspace summary' });
  const projectsMetric = summary.getByRole('link', {
    name: 'Projects 1 1 project',
  });
  await projectsMetric.focus();
  await expect(projectsMetric).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL('/projects');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Projects' }),
  ).toBeVisible();
});
```

- [ ] **Step 4: Run the Playwright test and observe the red state**

Run:

```bash
pnpm exec playwright test tests/e2e/scaffold.spec.ts --grep "metric card by keyboard"
```

Expected: FAIL because Workspace summary contains no Projects link. Do not change production code until this failure is observed.

### Task 2: Implement the reusable primitive

**Files:**

- Modify: `apps/control-plane/src/ui/components.ts:45-58`
- Test: `apps/control-plane/src/ui/components.test.ts`

- [ ] **Step 1: Add the minimal `MetricCard` implementation**

Add the primitive after `EmptyState`:

```ts
export function MetricCard({
  label,
  value,
  detail,
  href,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly detail: ReactNode;
  readonly href?: string;
}) {
  const content = [
    createElement('span', { className: 'metric-label' }, label),
    createElement('strong', { className: 'metric-value' }, value),
    createElement('span', { className: 'metric-detail' }, detail),
  ];
  const body =
    href === undefined
      ? createElement('div', { className: 'metric-card-body' }, ...content)
      : createElement(
          'a',
          { className: 'metric-card-body metric-card-link', href },
          ...content,
        );

  return createElement('article', { className: 'metric-card' }, body);
}
```

- [ ] **Step 2: Run the component tests and observe the green state**

Run:

```bash
pnpm --filter @agentos/control-plane test -- components.test.ts
```

Expected: PASS for the existing component tests and both new `MetricCard` tests.

### Task 3: Replace all six inline metrics and introduce explicit styles

**Files:**

- Modify: `apps/control-plane/app/page.tsx:1-51`
- Modify: `apps/control-plane/app/projects/[id]/page.tsx:1-130`
- Modify: `apps/control-plane/app/globals.css:380-411`

- [ ] **Step 1: Replace the dashboard metric articles**

Import `MetricCard` with the existing primitives and replace the metric-grid body with:

```tsx
<section aria-label="Workspace summary" className="metric-grid">
  <MetricCard
    detail={activeProjectsLabel}
    href="/projects"
    label="Projects"
    value={projectCount}
  />
  <MetricCard detail={waitingLabel} label="Recent runs" value={runs.length} />
  <MetricCard detail="Not configured" label="Budget" value="—" />
</section>
```

- [ ] **Step 2: Replace the project-detail metric articles**

Import `MetricCard` with the existing shared primitives and replace the project-summary metric-grid body with:

```tsx
<section aria-label="Project summary" className="metric-grid">
  <MetricCard detail={runCountLabel} label="Runs" value={project.runCount} />
  <MetricCard
    detail={
      project.configDigest === undefined
        ? 'No configuration applied'
        : `Digest ${project.configDigest.slice(0, 12)}…`
    }
    label="Latest revision"
    value={
      project.latestRevision === undefined ? '—' : `r${project.latestRevision}`
    }
  />
  <MetricCard
    detail={
      project.dailyBudgetMicrodollars === undefined
        ? 'Not configured'
        : `${formatBudgetMicrodollars(project.dailyBudgetMicrodollars)} daily cap`
    }
    label="Budget"
    value={
      project.workflowBudgetMicrodollars === undefined
        ? '—'
        : formatBudgetMicrodollars(project.workflowBudgetMicrodollars)
    }
  />
</section>
```

- [ ] **Step 3: Move card geometry to explicit reusable classes**

Replace `.metric-grid article` with:

```css
.metric-card {
  border: 1px solid var(--line-soft);
  border-radius: 0.65rem;
  background: color-mix(
    in srgb,
    var(--surface-inset) 55%,
    var(--surface-sheet)
  );
  box-shadow: none;
}

.metric-card-body {
  display: grid;
  height: 100%;
  min-height: 6.5rem;
  align-content: start;
  gap: 0.35rem;
  border-radius: inherit;
  padding: 1rem 1.1rem 1.1rem;
}

.metric-card-link {
  color: inherit;
  text-decoration: none;
}

.metric-card-link:hover {
  background: color-mix(in srgb, var(--signal-violet) 5%, transparent);
}
```

Do not add a metric-specific focus override; the existing global `a:focus-visible` rule must remain visible.

- [ ] **Step 4: Run focused unit, type, and lint checks**

Run:

```bash
pnpm --filter @agentos/control-plane test -- components.test.ts
pnpm --filter @agentos/control-plane typecheck
pnpm --filter @agentos/control-plane lint
```

Expected: all three commands pass.

- [ ] **Step 5: Run the Playwright regression and observe the green state**

Run:

```bash
pnpm exec playwright test tests/e2e/scaffold.spec.ts --grep "metric card by keyboard"
```

Expected: PASS; Enter on the Projects metric navigates from `/` to `/projects`.

### Task 4: Verify the complete approved slice and commit it

**Files:**

- Verify only: all files in the file map

- [ ] **Step 1: Run the control-plane test suite**

Run:

```bash
pnpm --filter @agentos/control-plane test
```

Expected: all control-plane tests pass.

- [ ] **Step 2: Run repository-wide typecheck, lint, and build**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all workspaces pass each gate and the Next.js production build completes.

- [ ] **Step 3: Run the complete Playwright scaffold**

Run:

```bash
pnpm exec playwright test tests/e2e/scaffold.spec.ts
```

Expected: all dashboard, projects, import, inbox, responsive, and authentication scenarios pass.

- [ ] **Step 4: Inspect the diff against the approved spec**

Run:

```bash
git diff --check
git status --short
git diff -- apps/control-plane/src/ui/components.ts apps/control-plane/src/ui/components.test.ts apps/control-plane/app/page.tsx 'apps/control-plane/app/projects/[id]/page.tsx' apps/control-plane/app/globals.css tests/e2e/scaffold.spec.ts
```

Expected: only the six approved implementation/test files are changed; all six inline metric articles use `MetricCard`; only dashboard Projects passes an `href`; no unrelated code is present.

- [ ] **Step 5: Commit the verified implementation**

```bash
git add apps/control-plane/src/ui/components.ts apps/control-plane/src/ui/components.test.ts apps/control-plane/app/page.tsx 'apps/control-plane/app/projects/[id]/page.tsx' apps/control-plane/app/globals.css tests/e2e/scaffold.spec.ts
git commit -m "feat(control-plane): link projects dashboard metric"
```

Expected: one implementation commit containing only the approved primitive, call sites, styling, and tests. Do not merge or push.
