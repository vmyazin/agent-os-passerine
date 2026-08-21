---
kind: logging_system
name: Minimal Console-Based Logging with CLI Structured Output
category: logging_system
scope:
    - '**'
source_files:
    - apps/cli/src/output.ts
    - apps/cli/src/main.ts
    - apps/control-plane/src/application/local-reconciliation-loop.ts
---

This repository does not use a dedicated logging framework. There are no imports of `pino`, `winston`, `bunyan`, `debug`, or any other structured logger in the codebase. Logging is implemented through two lightweight, ad-hoc mechanisms.

**CLI output (`apps/cli/src/output.ts`)** — The CLI formats command results for human-readable terminal tables and machine-readable JSON via `renderResult(value, json)`. It uses a local `canonical()` serializer that sorts object keys recursively to produce deterministic JSON output (via `@agentos/core`'s `canonicalJsonValue`). Errors go to `stderr`; successful results go to `stdout`. There is no log-level concept; all output is treated as either result data or error data.

**Control-plane application (`apps/control-plane/...`)** — The only runtime log call found is in `local-reconciliation-loop.ts`, which accepts an injectable `log` function defaulting to `console.info(message)` and prefixes messages with `[agentos]`. This is used solely for reporting when the local reconciliation loop cannot run (e.g., unconfigured dispatch). No other files in the control plane emit logs; HTTP routes, persistence, and application services do not write logs.

**Architecture & conventions observed:**
- No centralized logger singleton exists. Each component that needs to emit output does so directly via `console.*` or by writing to injected `stdout`/`stderr` streams.
- The CLI isolates I/O behind a `CliIo` interface (`stdout`, `stderr`, `readStdin`, `env`, `fetch`) so tests can capture output without touching real file descriptors.
- Error handling is uniform: exceptions are caught at the top-level `runCli` entry point, converted to a stable `{ error: { code, message } }` shape, and written to `stderr` (JSON when `--json` is passed, otherwise a plain `Error: ...` line).
- There is no log level configuration, no log rotation, no sinks, and no correlation IDs attached to log lines.

**Constraints enforced by the code:**
- CLI errors must be instances of `CliError` (with an `exitCode`) or `ApiError` (with a `code`); unknown errors map to exit code 1 and code `internal_error`.
- All CLI stdout output goes through `renderResult`, which guarantees deterministic key ordering for objects and arrays.
- The reconciliation loop's `log` parameter is typed as `(message: string) => void` and is injected for testability; production defaults to `console.info`.

Because there is no shared logging abstraction, adding structured logging would require introducing a new package or central module — none currently exists.