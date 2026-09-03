# Agent OS Passerine

Agent OS Passerine is a single-operator, GitHub-focused semi-autonomous build
system. It turns a feature request into reviewed artifacts and a tested draft
pull request while keeping approvals, budgets, credentials, and publication
authority outside model sessions.

## Quick start

Requires Node.js 24+ and pnpm 11.12.0.

### Local, no cloud accounts

```sh
pnpm install --frozen-lockfile
pnpm agentos init
pnpm test
pnpm --filter @agentos/control-plane dev --port 3010
```

Create `.env.local` at the repo root with only the values you use (never a
root `.env`, and never blank values — see the header of `.env.example`):

```sh
AGENTOS_PUBLIC_URL=http://localhost:3010
AGENTOS_SESSION_SECRET=$(openssl rand -hex 32)
AGENTOS_REPOSITORY=memory
AGENTOS_CLI_TOKEN=$(openssl rand -hex 32)   # same value in AGENTOS_API_TOKEN
```

Symlink it into the app once: `ln -s ../../.env.local apps/control-plane/.env.local`
(Next.js only loads env files from the app directory). Then open
`http://localhost:3010/login` and use the localhost "Get In" bypass — no
GitHub OAuth app is needed on localhost. Optional demo data: set
`AGENTOS_E2E_SEED=enabled` and `POST /api/test/seed`.

### Full stack

Real runs add, in order: a Neon Postgres (`DATABASE_URL`,
`AGENTOS_REPOSITORY=neon`, `pnpm db:migrate`), Cloudflare R2,
model keys (`ANTHROPIC_API_KEY`, optionally `KIMI_API_KEY`), the trust-anchor
secrets, two GitHub Apps (read-only reader + draft-PR publisher) bound to one
selected repository,. Every variable is documented in `.env.example`. Verify
credentials with the live smokes
(`AGENTOS_LIVE_TESTS=1 node packages/adapters/scripts/<r2|kimi|managed-agents>-smoke.mjs`).

Local experiment projects: set `AGENTOS_LOCAL_WORKSPACES_ROOT`, choose
"Local experiment" in the setup wizard at `/setup`, and runs end as
`agentos/<run>` branches in a local git repository instead of draft PRs —
no GitHub Apps required (agent sessions still execute in the Managed
Agents cloud and artifacts are stored in R2).

The no-cost test path uses in-memory/fake providers. Runs execute inside the
control-plane process; see the
[workflow runbook](./docs/architecture/durable-feature-workflow.md) for what
that means and what it costs.

Start with the [architecture overview](./docs/architecture/README.md), the
[durable workflow runbook](./docs/architecture/durable-feature-workflow.md),
and the [current build status](./docs/progress.md). Repository-owned agent,
environment, policy, budget, and pipeline definitions live under `agentos/`.

The system never merges or deploys code. The trusted publisher can create only
a draft PR; the operator reviews and merges it manually.
