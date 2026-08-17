# Agent OS workspace

The `agentos` CLI reads `agentos/agent-os.yaml` by default. Create the approved
v1 starter without overwriting an existing file:

```sh
agentos init
agentos config validate
agentos config plan
agentos config apply --idempotency-key config-2026-08-17
```

Use `--config PATH` for another file. Remote commands read `AGENTOS_URL` and
`AGENTOS_API_TOKEN`; flags with the same names (`--url` and `--token`) take
precedence. Non-local URLs must use HTTPS. Add `--json` for stable automation
output.

Run `agentos --help` for feature, goal, run, inbox, and approval commands. Every
mutation requires an explicit idempotency key, and approval decisions also
require the scope hash shown by the control plane.
