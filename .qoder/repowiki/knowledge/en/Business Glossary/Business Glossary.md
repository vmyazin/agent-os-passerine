---
kind: business_term
name: Business Glossary
category: business_term
scope:
    - '**'
---

### Agent OS Passerine
- Definition：The product name of this monorepo: a single-operator, GitHub-focused semi-autonomous build system that turns a feature request into reviewed artifacts and a tested draft pull request while keeping approvals, budgets, credentials, and publication authority outside model sessions.
- Aliases：Passerine、Agent OS

### Control Plane
- Definition：The Next.js web application (`apps/control-plane`) that operators use to review runs, answer agent questions, approve narrowly scoped actions, and inspect evidence. It exposes both the UI and the REST API consumed by the CLI and GitHub App webhooks.
- Aliases：control-plane

### Run
- Definition：A single execution of the agent pipeline triggered by a feature request or goal. Each run has a deterministic SHA-256 ID, a timeline of steps/goals, and an audit trail of approvals and budget spend.
- Aliases：run

### Setup Wizard
- Definition：The multi-step onboarding flow at `/setup` that configures the control plane — local experiment mode, YAML configuration, GitHub App binding, and initial run start. Step 2 presents editable YAML with 'Fill' shortcuts in local mode.
- Aliases：setup wizard

### Local experiment mode
- Definition：A setup-wizard mode enabled by setting `AGENTOS_LOCAL_WORKSPACES_ROOT` that ends runs as `agentos/<run>` branches in a local git repository instead of creating draft PRs, allowing full end-to-end testing without GitHub Apps.
- Aliases：local experiment

### Managed Agents
- Definition：The remote execution environment where agent sessions actually run (sandboxed processes). Artifacts produced there are stored in R2; the control plane owns session ownership via `AGENTOS_RUNTIME_OWNERSHIP_SECRET` and sealed handles via `AGENTOS_RUNTIME_HANDLE_KEY`.
- Aliases：managed agents

### Artifact MCP
- Definition：A scoped Model Context Protocol endpoint (`AGENTOS_ARTIFACT_MCP_URL`) that managed sessions call to fetch artifacts. Operators receive a vault reference per step rather than raw tokens; origins are whitelisted via `ARTIFACT_MCP_ALLOWED_ORIGINS`.
- Aliases：artifact mcp

### Trusted test commands
- Definition：A JSON map (`AGENTOS_TRUSTED_TEST_COMMANDS_JSON`) that whitelists exact agent-reported test commands to trusted executables/argv, enabling bounded execution of test suites inside the verification sandbox with lifecycle scripts disabled.
- Aliases：trusted test commands

### Verification registry hosts
- Definition：An allowlist (`AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON`) of exact package registry hosts reachable only by the secretless verification sandbox during frozen-lockfile installs, used to verify packages without executing lifecycle scripts.
- Aliases：verification registry hosts

### Deployment daily microdollars
- Definition：A rolling daily spend cap (`AGENTOS_DEPLOYMENT_DAILY_MICRODOLLARS`) expressed in microdollars across all projects, applied deployment-wide to bound model usage cost.
- Aliases：daily microdollars、spend cap

### Draft PR
- Definition：The final output artifact produced by the trusted publisher GitHub App. The system never merges or deploys code automatically — the operator reviews and merges the draft PR manually.
- Aliases：draft PR

### Outbox reconciliation
- Definition：Server-side mechanism ensuring atomicity between state changes and side effects (webhooks, artifact uploads) using Postgres functions plus deterministic SHA-256 IDs, so missed events can be replayed safely.
- Aliases：outbox
