---
kind: dependency_management
name: pnpm + Turborepo Monorepo Dependency Management
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - turbo.json
    - pnpm-lock.yaml
    - packages/core/package.json
    - packages/adapters/package.json
    - apps/cli/package.json
    - apps/control-plane/package.json
---

## System Overview

Agent OS is a TypeScript monorepo managed with **pnpm workspaces** and **Turborepo**. The root `package.json` declares the workspace, pins the exact pnpm version via the `packageManager` field (`pnpm@11.12.0`), and enforces Node.js `>=24.0.0`. All third-party dependencies are declared per-package (no hoisting to root) and resolved through a single shared lockfile.

## Key Files

- `package.json` — Root workspace manifest; defines top-level scripts that delegate to Turborejo (`turbo run build`, `turbo run lint`, `turbo run test`, `turbo run typecheck`) and the `agentos` CLI entrypoint.
- `pnpm-workspace.yaml` — Declares workspace member globs (`apps/*`, `packages/*`) and two pnpm-specific settings: `allowBuilds` (disables native builds for `@depot/cli`, enables `esbuild`) and `minimumReleaseAgeExclude` (exempts `@trigger.dev/core` and `@trigger.dev/sdk` from pnpm's minimum release age policy).
- `turbo.json` — Defines task graph rules: `build` depends on `^build`, `test` depends on `^build`, `typecheck` depends on `^typecheck`; output artifacts are `.next/**` and `dist/**`.
- `pnpm-lock.yaml` — Single deterministic lockfile at the repo root that pins every transitive dependency across all packages.
- Per-package `package.json` files under `apps/` and `packages/` — Each package declares its own runtime `dependencies` and `devDependencies`.

## Architecture & Conventions

### Workspace layout
The workspace groups members into two categories:
- `apps/*` — Consuming applications: `@agentos/cli` (Node CLI exposing an `agentos` binary) and `@agentos/control-plane` (Next.js app).
- `packages/*` — Internal libraries: `@agentos/core` (domain types, config schemas, state machines) and `@agentos/adapters` (pluggable backend adapters re-exported behind a single surface).

Internal packages reference each other using the `workspace:*` protocol (e.g., `@agentos/adapters` depends on `@agentos/core` as `workspace:*`; `@agentos/control-plane` depends on both `@agentos/core` and `@agentos/adapters` as `workspace:*`; `@agentos/cli` depends on `@agentos/core` as `workspace:*`). This ensures local development uses the in-repo source rather than published versions.

### Version pinning strategy
Every dependency in this repo is pinned to an exact semver version — no caret or tilde ranges. Examples include `zod@4.4.3`, `yaml@2.9.0`, `next@16.3.1`, `react@19.2.8`, `drizzle-orm@0.45.2`, `@anthropic-ai/sdk@0.117.1`, `@aws-sdk/client-s3@3.1111.0`, `turbo@2.10.10`, `vitest@4.1.10`, etc. The lockfile is the source of truth for reproducible installs.

### Build system integration
Turborejo orchestrates the pipeline. Tasks declare cross-package ordering via the `^` prefix (e.g., `dependsOn: ["^build"]` means "run my sibling's build first"). Output directories (`.next/**`, `dist/**`) are cached by Turborepo's remote cache stored under `.turbo/cache/`.

### Private registry / vendoring
There is no private npm registry configured in any visible file. Dependencies come from the public npm registry. Native addon builds are gated via `pnpm-workspace.yaml`'s `allowBuilds` list, which explicitly disables `@depot/cli` and enables `esbuild` — preventing accidental native compilation during install.

### Trigger.dev exception
The `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` exempts `@trigger.dev/core@4.5.12` and `@trigger.dev/sdk@4.5.12` from pnpm's minimum release age check, allowing these packages to be installed even if they were recently published. Note that `@agentos/adapters` pins `@trigger.dev/sdk@4.5.11` while the root `devDependencies` pins `@trigger.dev/sdk@4.5.12` and `@trigger.dev/core@4.5.12` — the exclusion exists specifically to allow the newer SDK version used by the root dev tooling.

## Conventions & Constraints

- **Workspace-only internal deps**: Internal packages (`@agentos/core`, `@agentos/adapters`) are consumed exclusively via `workspace:*`, never via version ranges.
- **Exact version pinning**: All `dependencies` and `devDependencies` use exact versions; updates should be applied via `pnpm up --latest` and committed alongside the updated `pnpm-lock.yaml`.
- **Single lockfile**: There is one `pnpm-lock.yaml` at the repository root; do not maintain per-package lockfiles.
- **No vendored node_modules**: Packages rely on pnpm's content-addressable store; nothing is vendored inside the repo except the lockfile.
- **Task graph discipline**: New Turborepo tasks must declare appropriate `dependsOn` relationships so that downstream packages rebuild before testing/typechecking.
- **Native build gating**: Any new package that ships native addons must be reviewed against `pnpm-workspace.yaml`'s `allowBuilds` list to avoid unexpected compile steps.