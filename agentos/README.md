# Agent OS workspace

The `agentos` CLI finds the repository root from the current directory and reads
`agentos/agent-os.yaml` there by default, so the same commands work from nested
directories. Create the approved v1 starter without overwriting an existing
file:

```sh
pnpm agentos init
pnpm agentos config validate
pnpm agentos config plan
pnpm agentos config apply --idempotency-key config-2026-08-17
```

`config apply` reads the active revision immediately before submitting the
change. If another operator applies first, it exits with a stale-configuration
conflict; rerun `config plan` before applying again.

Use `--config PATH` for another file inside the repository. Paths are resolved
from the repository root; traversal and symbolic-link paths are rejected. The
repository root and every existing directory down to the configuration parent
must be owned by the current user (on platforms that expose ownership) and
must not be writable by the group or other users.

The CLI checks those directories again at the file-operation boundary and uses
no-follow and exclusive file operations. Node does not expose portable
directory-relative `openat` operations, so a process running as the same user
could still replace a trusted directory between validation and use. Treat other
same-UID processes as trusted and keep the repository itself protected.

Remote commands read `AGENTOS_URL` and `AGENTOS_API_TOKEN`; flags with the same
names (`--url` and `--token`) take precedence. Non-local URLs must use HTTPS. Add
`--json` for stable automation output.

Run `pnpm agentos --help` for feature, goal, run, inbox, and approval commands.
Every mutation requires an explicit idempotency key, and approval decisions
also require the scope hash shown by the control plane.
