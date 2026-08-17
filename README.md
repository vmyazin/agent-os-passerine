# Agent OS Passerine

Agent OS Passerine is a single-operator, GitHub-focused semi-autonomous build
system. It turns a feature request into reviewed artifacts and a tested draft
pull request while keeping approvals, budgets, credentials, and publication
authority outside model sessions.

## Quick start

Requires Node.js 24+ and pnpm 11.12.0.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm agentos init
pnpm agentos config validate
pnpm test
pnpm --filter @agentos/control-plane dev
```

The no-cost test path uses in-memory/fake providers. Production uses Neon,
Trigger.dev, Managed Agents, R2, and a selected-repository GitHub App through
the same stable contracts.

Start with the [architecture overview](./docs/architecture/README.md), the
[durable workflow runbook](./docs/architecture/durable-feature-workflow.md),
and the [current build status](./docs/progress.md). Repository-owned agent,
environment, policy, budget, and pipeline definitions live under `agentos/`.

The system never merges or deploys code. The trusted publisher can create only
a draft PR; the operator reviews and merges it manually.
