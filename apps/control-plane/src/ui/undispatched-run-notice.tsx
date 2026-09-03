// src/ui/undispatched-run-notice.tsx

/**
 * Shown on a run that was handed over and never executed. The control plane
 * looks healthy in this state -- the run record, its config snapshot and its
 * provenance are all correct -- so the notice has to name the one thing that
 * is missing: the execution itself, which lives in this process and does not
 * survive it.
 */
export function UndispatchedRunNotice() {
  return (
    <p className="notice" role="status">
      <strong>Queued, but nothing has executed it.</strong> A run executes
      inside this control plane. If it was restarted after the handoff, the
      execution was lost and nothing retries it on its own: use Retry, which
      hands the run over again from where it stopped.
    </p>
  );
}
