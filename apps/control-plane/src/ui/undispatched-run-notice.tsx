// src/ui/undispatched-run-notice.tsx

/**
 * Shown on a run that no worker ever claimed. Names the cause and the exact
 * command, because the control plane looks healthy in this state: the run
 * record, its config snapshot, and its provenance are all correct, and
 * environment readiness is green -- the only missing piece is a process the
 * control plane cannot see. Says nothing about automatic recovery, because
 * whether this run resumes by itself depends on where dispatch stopped, and
 * the page cannot tell.
 */
export function UndispatchedRunNotice({
  executor = 'trigger',
}: {
  readonly executor?: 'trigger' | 'local-direct';
} = {}) {
  if (executor === 'local-direct')
    return (
      <p className="notice" role="status">
        <strong>Queued, but nothing has executed it.</strong> On the local
        executor a run executes inside this control plane. If the control plane
        was restarted after the handoff, the execution was lost and nothing
        retries it on its own: use Retry, which hands it over again from where
        it stopped.
      </p>
    );
  return (
    <p className="notice" role="status">
      <strong>Queued, but nothing picked it up.</strong> Runs execute in a
      Trigger.dev worker, and none is connected to this environment. Locally,
      start one in a second terminal with{' '}
      <code>npx trigger.dev@latest dev</code>; a deployment needs{' '}
      <code>pnpm trigger:deploy</code>. Setting <code>TRIGGER_SECRET_KEY</code>{' '}
      only enqueues work — it does not execute it.
    </p>
  );
}
