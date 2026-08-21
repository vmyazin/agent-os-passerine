---
kind: configuration_system
name: AgentOS Configuration System — YAML Schema, Env Vars, and Workspace-Scoped Config Loading
category: configuration_system
scope:
    - '**'
source_files:
    - packages/core/src/config.ts
    - apps/cli/src/config-files.ts
    - apps/cli/src/workspace.ts
    - apps/control-plane/src/config/configuration-loader.ts
    - .env.example
    - drizzle.config.ts
    - trigger.config.ts
    - playwright.config.ts
    - apps/cli/src/main.ts
---

## Overview

AgentOS uses a layered configuration system that combines **declarative YAML workspace definitions** (validated by Zod schemas) with **environment variables** for runtime secrets and service wiring. The core schema lives in `packages/core/src/config.ts`; the CLI reads and writes per-workspace YAML files under a trusted directory tree; the Next.js control plane loads a single production config file via an explicit path.

## Core schema and validation

- All AgentOS workspace configuration is defined by a single Zod schema (`AgentOsConfigSchema`) in `packages/core/src/config.ts`. It enforces:
  - A fixed `version: 1` literal.
  - Typed sections: `project`, `models`, `agents`, `environments`, `pipelines`, `policies`, `budgets`, `goals`, `runtime`, `verification`.
  - Cross-field references validated at parse time (e.g. every `agent.model` must exist in `models`; pipeline steps reference known agents/environments; no duplicate step ids; no self-referencing or cyclic `dependsOn`).
  - Protected-path defaults that block `.git`, `.env*`, `CODEOWNERS`, etc., from agent write access.
- Two parsing helpers are exported: `parseAgentOsConfig` (raw object) and `loadAgentOsConfig` (YAML string → parsed object). Both go through the same schema so CLI and server share identical validation rules.
- Canonicalization utilities (`canonicalConfigJson`, `canonicalConfigHash`, `semanticConfigDiff`, `planConfigChange`) produce deterministic JSON and SHA-256 digests of configs, used as immutable revision identifiers across the control plane.
- Size limits are enforced at load time: `MAX_AGENT_OS_CONFIG_SOURCE_BYTES` (56 KiB), `MAX_CANONICAL_CONFIG_BYTES` (384 KiB), and `MAX_CONFIGURATION_APPLY_BODY_BYTES` (512 KiB).

## CLI configuration loading (`apps/cli/src/config-files.ts`)

- Reads a user-specified YAML file via `readConfiguration(path)` which:
  - Traverses up to find the workspace root (markers: `.git` or `pnpm-workspace.yaml`).
  - Asserts every component of the path is inside the workspace, is not a symlink, has safe ownership/permissions (`uid === process.getuid()`, no world/group-writable bits), and is a regular file.
  - Reads with `O_NOFOLLOW` and caps bytes read to the configured maximum.
  - Parses through `loadAgentOsConfig` and then checks canonical size.
- `initConfiguration` creates a starter `agentos/example.yaml` using an embedded template (`STARTER_CONFIG`) that mirrors the full schema shape, writing atomically via a temp file + rename/link with `0o700`/`0o600` permissions.
- The CLI's connection settings (`AGENTOS_URL`, `AGENTOS_API_TOKEN`) are read from `process.env` in `apps/cli/src/main.ts` and can be overridden by `--url` / `--token` flags.

## Control-plane configuration loading (`apps/control-plane/src/config/configuration-loader.ts`)

- In production, `AGENTOS_CONFIG_PATH` **must** be set; otherwise `loadConfigurationMetadata` throws. This forces an explicit, auditable config location.
- In development, if no path is provided it falls back to `agentos/example.yaml` relative to the repo root (detected by walking up from `apps/control-plane`).
- The loader resolves absolute paths, reads the YAML, parses it through `@agentos/core`, and returns a lightweight metadata object containing version, digest, project name/default branch, runtime provider, and counts of models/agents/environments/pipelines/steps.
- The control plane also exposes `/api/configuration` and a UI page that render the current configuration (with secret redaction patterns applied to strings before display).

## Environment variables

The repository documents all supported env vars in `.env.example`. They fall into these categories:

| Category | Variables | Purpose |
|---|---|---|
| Server identity & auth | `AGENTOS_PUBLIC_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ALLOWED_LOGIN`, `AGENTOS_SESSION_SECRET`, `AGENTOS_CLI_TOKEN` | OAuth, session cookie signing, CLI API token |
| CLI connection | `AGENTOS_URL`, `AGENTOS_API_TOKEN` | Where the CLI talks to the control plane |
| Persistence | `AGENTOS_REPOSITORY=memory|neon`, `DATABASE_URL` | In-memory vs Neon Postgres |
| Workflows | `TRIGGER_PROJECT_REF`, `TRIGGER_SECRET_KEY` | Trigger.dev v4 coordination |
| Model providers | `ANTHROPIC_API_KEY`, `KIMI_API_KEY`, `KIMI_BASE_URL` | Runtime model credentials |
| Managed Agents security | `AGENTOS_RUNTIME_OWNERSHIP_SECRET`, `AGENTOS_RUNTIME_HANDLE_KEY`, `AGENTOS_TRUSTED_TEST_COMMANDS_JSON`, `AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON`, `AGENTOS_DEPLOYMENT_DAILY_MICRODOLLARS`, `AGENTOS_TEST_REPORT_KEYS_JSON` | Session keys, sandbox allowlists, spend caps, attestation HMAC rotation |
| GitHub publishing | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_READER_*`, `GITHUB_PUBLICATION_KEYS_JSON`, `GITHUB_SELECTED_REPOSITORIES_JSON`, `GITHUB_READER_SELECTED_REPOSITORIES_JSON` | Bounded publisher identity and repo allowlist |
| Local experiments | `AGENTOS_LOCAL_WORKSPACES_ROOT` | Absolute directory for local experiment mode |
| Artifacts/MCP | `CLOUDFLARE_R2_*`, `CRON_SECRET`, `ARTIFACT_CAPABILITY_KEYS_JSON`, `AGENTOS_ARTIFACT_MCP_URL`, `ARTIFACT_MCP_ALLOWED_ORIGINS` | R2-backed artifact storage, cron auth, capability tokens |

Environment variables are consumed directly via `process.env` throughout the codebase (e.g. `drizzle.config.ts`, `trigger.config.ts`, `playwright.config.ts`, control-plane routes). There is no central env-loading library — each tool reads what it needs.

## Build/tooling config

- `drizzle.config.ts`: reads `DATABASE_URL` from env; omits `dbCredentials` when undefined so Drizzle Kit runs without a live DB.
- `trigger.config.ts`: reads `TRIGGER_PROJECT_REF` with a hardcoded fallback project ref for dev.
- `playwright.config.ts`: hardcodes the E2E base URL and injects a minimal set of env vars (`AGENTOS_E2E_SEED`, `AGENTOS_REPOSITORY=memory`, `AGENTOS_PUBLIC_URL`, GitHub test creds, `AGENTOS_SESSION_SECRET`) when booting the dev server for tests.

## Conventions and constraints

1. **Workspace-scoped YAML only**: The CLI refuses any configuration path outside the discovered workspace root and rejects symlinks at every path component — this is enforced by `assertTrustedConfigurationDirectories` and `resolveConfigurationPath`.
2. **No root `.env`**: The `.env.example` comment explicitly states that nothing reads a root `.env`; values belong in `.env.local` (gitignored) and are symlinked into `apps/control-plane` for Next.js.
3. **Production requires explicit config path**: `AGENTOS_CONFIG_PATH` is mandatory in production; omitting it causes startup failure.
4. **Secrets never leave server-side code**: The control plane applies regex-based redaction (`VALUE_SECRET_PATTERNS`) to any configuration value before exposing it over HTTP or logging.
5. **Single source of truth for schema**: Both CLI and control plane import `loadAgentOsConfig` / `parseAgentOsConfig` from `@agentos/core`; adding a field means updating one schema and both consumers validate identically.
6. **Immutable revisions**: Every persisted configuration is identified by `canonicalConfigHash(config)` (SHA-256 of canonical JSON), enabling change detection and audit trails.
7. **Defaults are safe-by-default**: Policies default to blocking binaries/symlinks and restricting tools/MCPs to empty allowlists; budgets default to finite microdollar caps.