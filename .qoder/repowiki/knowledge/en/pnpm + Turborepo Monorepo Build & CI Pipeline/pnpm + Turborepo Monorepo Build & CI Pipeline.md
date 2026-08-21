---
kind: build_system
name: pnpm + Turborepo Monorepo Build & CI Pipeline
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - turbo.json
    - pnpm-workspace.yaml
    - .github/workflows/ci.yml
    - trigger.config.ts
    - vercel.json
    - apps/control-plane/package.json
    - apps/cli/package.json
    - packages/core/package.json
    - packages/adapters/package.json
    - drizzle.config.ts
    - tsconfig.base.json
---

## Build System Overview

Agent OS is a TypeScript monorepo built with **pnpm workspaces** and orchestrated by **Turborepo**. The root `package.json` defines top-level scripts that delegate to Turborepo, which coordinates task execution across all workspace packages.

### Core Tools
- **Package manager**: pnpm 11.12.0 (enforced via `packageManager` field in root `package.json`)
- **Workspace definition**: `pnpm-workspace.yaml` declares two workspace roots: `apps/*` and `packages/*`
- **Task runner**: Turborepo 2.x (`turbo.json`) defines the build graph
- **Node runtime**: Node.js >=24.0.0 (declared in `engines`)
- **TypeScript compiler**: tsc 6.0.3 per-package; shared base config at `tsconfig.base.json`
- **Testing**: Vitest 4.x per package, Playwright for E2E
- **Linting/formatting**: ESLint 10 + Prettier 3
- **Database migrations**: Drizzle Kit (`drizzle.config.ts`, `db:*` scripts)
- **Serverless workflows**: Trigger.dev configured via `trigger.config.ts`
- **Deployment target**: Vercel (`vercel.json`), with scheduled cron routes

### Workspace Layout
- `apps/control-plane/` — Next.js 16 App Router application; builds via `next build`, outputs `.next/`
- `apps/cli/` — Node CLI published as `agentos` binary (`dist/index.js`); built via `tsc -p tsconfig.build.json`
- `packages/core/` — Shared domain library with explicit `exports` map pointing to `./dist/index.{js,d.ts}`
- `packages/adapters/` — Pluggable backend adapters (artifacts, GitHub, Neon, Trigger.dev, providers)

Each package exposes standard scripts: `build`, `lint`, `test`, `typecheck`. Root scripts (`pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`) invoke `turbo run <task>` to execute them in parallel with dependency ordering.

### Turborepo Task Graph (`turbo.json`)
- `build`: depends on `^build` (upstream dependencies build first); caches outputs matching `.next/**` and `dist/**`
- `test`: depends on `^build` (tests run after upstream builds)
- `lint`: depends on `^lint`
- `typecheck`: depends on `^typecheck`

This means downstream packages (e.g., `@agentos/control-plane` depending on `@agentos/core` and `@agentos/adapters`) will have their dependencies built before they are tested or linted.

### CI Pipeline (`.github/workflows/ci.yml`)
Two jobs run on push to `main` and pull requests:

1. **quality job** (ubuntu-latest, 15 min timeout):
   - Checks out code, installs pnpm 11.12.0, sets up Node 24 with pnpm cache
   - Runs `pnpm install --frozen-lockfile`
   - Executes `format:check`, `lint`, `typecheck`, `test`, then `playwright install --with-deps chromium` followed by `test:e2e`

2. **persistence-integration job** (ubuntu-latest, 10 min timeout):
   - Spins up a PostgreSQL 16 container service (`postgres:16.4-alpine3.20` with pinned digest)
   - Exposes `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agentos_test`
   - Installs deps and runs `pnpm test:integration` (which filters to `@agentos/adapters`)

### Build Conventions
- Each package has its own `tsconfig.json` plus a `tsconfig.build.json` used for compilation output
- Packages publish compiled JS under `dist/` (CLI) or `.next/` (Next.js app)
- Internal packages use `workspace:*` protocol for cross-package dependencies
- `pnpm-workspace.yaml` explicitly allows `esbuild` builds but blocks `@depot/cli` from running builds during install
- `minimumReleaseAgeExclude` lists specific Trigger.dev packages to bypass minimum release age checks

### Deployment
- **Vercel**: `vercel.json` defines two scheduled cron jobs — `/api/internal/artifacts/cleanup` every 10 minutes and `/api/internal/workflows/reconcile` every 5 minutes
- **Trigger.dev**: Workflows live in `packages/adapters/src/trigger`, deployed via `pnpm trigger:deploy`, using `node-22` runtime with retry policy (max 2 attempts, exponential backoff 1s–10s)
- **Local CLI**: `pnpm agentos` builds the CLI and immediately runs it via `node apps/cli/dist/index.js`

### Database
- Schema defined via Drizzle ORM (`drizzle.config.ts`, `drizzle/` directory)
- Migration commands exposed at root: `db:generate`, `db:migrate`, `db:check`
- Integration tests against a real PostgreSQL instance provisioned in CI