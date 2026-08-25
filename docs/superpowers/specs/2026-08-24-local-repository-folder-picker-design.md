# Local Repository Folder Picker

Status: Approved design

## Context

The existing project-import dialog accepts an absolute local working-tree path.
That is the correct trust input for `project_sources`, but requiring operators to
type or paste a path makes local import needlessly awkward.

Browser directory APIs do not expose a server-usable absolute POSIX path. The
control plane already runs locally on the operator's machine, so on macOS it can
open Finder itself and return the selected directory path to the authenticated
dialog.

## Goals

- Add a **Choose folder…** action beside the local repository path field.
- Open the native macOS Finder directory chooser from the local control-plane
  process.
- Fill the existing editable path field without automatically inspecting or
  importing the repository.
- Preserve the current exact-path inspection and canonicalization boundary.
- Keep manual path entry available as the universal fallback.

## Non-goals

- Cross-platform native pickers, Electron, Tauri, or another desktop shell.
- Uploading directory contents through browser file APIs.
- Changing local repository validation, canonical source identity, commit
  browsing, source ingestion, workflow execution, publication, prompts, or
  generated documentation.
- Granting repository trust merely because a folder was selected.

## Scope and implementation boundary

The native capability lives in a focused server-only helper under
`apps/control-plane/src/local-system/`. An authenticated project-import route
invokes that helper, and `ImportProjectDialog` renders the action only when a
server component confirms that the process is macOS and the configured public
URL is localhost.

Do not modify `packages/core`, `packages/adapters`, the `project_sources` schema,
local Git inspection, commit readers, runtime dispatch, source snapshots,
publication, Trigger workflows, agent prompts, or `.qoder/repowiki/`.

## Approved behavior

### Interaction

- The GitHub form is unchanged.
- Selecting **Local repository** shows the editable path input and, when the
  capability is available, a secondary **Choose folder…** button on the same row.
- Activating the button opens Finder with the prompt “Choose a local Git
  repository.”
- A successful selection replaces the path field, clears stale inspection/error
  state, and returns focus to the path input.
- Cancelling Finder is a no-op: the path, inspection state, and message remain
  unchanged.
- While Finder is open, the picker button reads **Choosing…** and duplicate
  picker, inspection, and import actions are disabled.
- Picker failure is shown in the dialog's existing polite error notice. It does
  not close the Radix dialog.

### Native boundary and security

- Availability requires all three conditions: `process.platform === 'darwin'`,
  a non-production process, and the existing configured localhost public-URL
  signal.
- The route requires an authenticated browser session. CLI bearer tokens cannot
  open OS UI.
- Existing browser-mutation origin enforcement must accept the request before
  Finder opens.
- Invoke `/usr/bin/osascript` with `execFile`, a static script, no shell, no
  interpolated user input, a small output buffer, and a bounded timeout.
- AppleScript handles cancellation error `-128` and emits an empty result, so
  cancellation is distinct from execution failure without parsing localized
  error prose.
- The route returns only `{ status: 'selected', path }` or
  `{ status: 'cancelled' }`; it stores nothing.
- The normal inspect endpoint remains responsible for proving that the selected
  directory is the exact non-bare Git working-tree root and resolving its real
  path.

### Visual direction

Preserve the current operator-console design system: white sheet, inset gray
surfaces, dark green-black text, and violet focus/action accents. The only new
signature element is the compact secondary picker action paired with the path
field; no new component library or visual vocabulary is introduced.

## Failure behavior

- Unsupported environments do not render the button and the route rejects
  direct calls with a sanitized unavailable error.
- Missing authentication, cross-origin requests, and CLI-token requests are
  rejected before any child process starts.
- Native command failures and timeouts return a sanitized picker-unavailable
  error; stderr and local filesystem details are not sent to the browser.
- Malformed or oversized native output is rejected rather than inserted into
  the field.

## Verification

- Unit tests cover availability, selection, cancellation, timeout/failure, and
  bounded output using an injected command runner.
- Route tests cover browser authentication/origin, CLI rejection, unavailable
  environments, selection, and cancellation with the native helper mocked.
- Playwright mocks the picker route and verifies conditional rendering, loading,
  field population, cancellation, error retention, focus, and the unchanged
  inspect flow.
- Run control-plane tests, typecheck, lint, build, and the relevant Playwright
  scenario, then smoke-test `/projects` on a non-default port.
