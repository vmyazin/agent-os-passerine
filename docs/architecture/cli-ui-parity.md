# CLI and browser parity

Two surfaces reach the same control plane. The CLI is for automation and
machine-readable output; the browser is for an operator making decisions.
Anything an operator does should be possible in the browser, and a
capability added to one surface without the other is a gap, not a plan.

Keep this table current when either surface changes.

| CLI | Browser | Notes |
| --- | --- | --- |
| `init` | — | Deliberate. Writes a local file; the browser has no filesystem. The setup wizard generates the same template. |
| `config validate` | Editor → **Plan** | Invalid YAML is rejected with the parser's message. |
| `config plan` | Configuration → **Plan** | Diff against the active revision. Values under `environments[].variables` are masked — the canonical config is never returned to a session. |
| `config apply` | Configuration → **Apply**, or Setup step 2 | Session route is `/api/setup/apply`; `POST /api/configuration` stays CLI-token-only. |
| `feature start` | Project → **Start work** | Provenance is resolved from the applied revision, never typed. |
| `feature start --base-run` | Run page → **Start a follow-up** | Offered on a succeeded run that recorded a published commit. |
| `goal start` | Project → **Start work** → Goal | Criteria are chosen from the project's trusted allowlist. |
| `goal show` | Run page | Step count, criteria, and per-criterion results. |
| `runs list` | `/runs` | Project filter chips. |
| `runs show` | `/runs/[id]` | |
| `runs cancel` | Run page → **Cancel run** | Two-step, because it is not reversible. |
| `inbox list` | `/inbox` | |
| `inbox reply` | Inbox reading pane | |
| `inbox approve` / `reject` | Inbox reading pane | Shows the frozen acceptance tests before the decision. |
| — | Project → **Create a backlog** | Browser-only so far. `POST /api/backlogs` exists for scripts. |
| — | Backlog → **Pause** / **Resume** | Browser-only so far. |
| `--json` | — | Deliberate. Machine-readable output is the CLI's contract. |

## Where an action lives

A run is started from the project that will own it, or from the run it
follows. A backlog is created, paused, and resumed on its project's page.
Configuration is planned and applied on the configuration page. Setup keeps
one job: taking a project from nothing to a first applied configuration.

## What the browser never gets

`GET /api/configuration` returns provenance to a session but withholds
`canonicalConfig`, because `environments[].variables` is a free-form string
map that may hold credentials. The configuration page masks those values in
the applied revision it renders, the plan endpoint masks them on both sides
of a diff — including when a whole environment is added or removed and the
change carries the entire object — and the editor does not start populated.
