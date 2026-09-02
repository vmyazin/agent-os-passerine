'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { InboxAttentionChangedDetail } from './inbox-count-client';
import { completeInboxMutation } from './inbox-mutation-success';

/**
 * Prefer the server's explanation over a generic retry prompt. A 409 here
 * means the decision can never succeed -- the approval expired, or someone
 * already decided it -- and telling the operator to try again sends them
 * into a loop that cannot end.
 */
async function failureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string };
    };
    const message = body.error?.message;
    if (typeof message === 'string' && message !== '')
      return response.status === 409
        ? `Could not save: ${message}.`
        : `Could not save: ${message}. Please try again.`;
  } catch {
    // Fall through to the generic message below.
  }
  return response.status === 409
    ? 'Could not save. This request is no longer open.'
    : 'Could not save. Please try again.';
}

function useMutation(inboxMutation?: InboxAttentionChangedDetail) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const mutate = async (url: string, body: object) => {
    if (pending) return;
    setPending(true);
    setMessage('Saving…');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      setMessage(response.ok ? 'Saved.' : await failureMessage(response));
      statusRef.current?.focus();
      if (response.ok) {
        if (inboxMutation !== undefined)
          completeInboxMutation(router.refresh, inboxMutation);
        else location.reload();
      }
    } finally {
      setPending(false);
    }
  };
  return { message, mutate, pending, statusRef };
}

export function ApprovalActions({
  approvalId,
  scopeHash,
}: {
  readonly approvalId: string;
  readonly scopeHash: string;
}) {
  const { message, mutate, pending, statusRef } = useMutation({
    advanceSelection: true,
    resolvedKey: `approval:${approvalId}`,
  });
  return (
    <div className="action-stack">
      <div className="button-row">
        <button
          onClick={() =>
            void mutate(`/api/approvals/${approvalId}/approve`, { scopeHash })
          }
          disabled={pending}
          type="button"
        >
          Approve request
        </button>
        <button
          className="secondary"
          disabled={pending}
          onClick={() =>
            void mutate(`/api/approvals/${approvalId}/reject`, { scopeHash })
          }
          type="button"
        >
          Reject request
        </button>
      </div>
      <p aria-live="polite" ref={statusRef} tabIndex={-1}>
        {message}
      </p>
    </div>
  );
}

/**
 * Starting a finished run's request again.
 *
 * It creates a new run rather than re-dispatching this one: the original is
 * the record of what happened, and provenance is resolved again from the
 * configuration applied now -- usually the reason the operator is here.
 * Two-step, because it spends money.
 */
/** $2.00, enough for several steps at observed per-step cost. */
const DEFAULT_BUDGET_OVERRIDE_MICRODOLLARS = 2_000_000;

/**
 * Granting a run a one-time allowance past the budget that stopped it.
 *
 * Deliberately separate from resuming. Granting raises this run's caps and
 * changes nothing else, so the operator authorises the spend and then decides
 * to continue -- two decisions, because the first one is about money.
 */
export function OverrideRunBudgetAction({
  runId,
  microdollars = DEFAULT_BUDGET_OVERRIDE_MICRODOLLARS,
}: {
  readonly runId: string;
  readonly microdollars?: number;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const amount = `$${(microdollars / 1_000_000).toFixed(2)}`;
  const grant = async () => {
    if (pending) return;
    setPending(true);
    setMessage('Granting…');
    const response = await fetch(`/api/runs/${runId}/budget-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ microdollars }),
    });
    if (response.ok) {
      setMessage(`Granted ${amount}. Resume the run to spend it.`);
      setPending(false);
      return;
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    setMessage(
      typeof body.error?.message === 'string'
        ? `Could not grant it: ${body.error.message}.`
        : 'Could not grant it.',
    );
    setPending(false);
  };
  return (
    <div className="action-stack">
      <div className="button-row">
        <button
          className="secondary"
          disabled={pending}
          onClick={() => void grant()}
          type="button"
        >
          {pending ? 'Granting…' : `Allow ${amount} more`}
        </button>
      </div>
      <p aria-live="polite">{message}</p>
    </div>
  );
}

/**
 * Continuing a finished run from where it stopped, keeping the steps it
 * already paid for. Single-step, unlike starting again: it spends only what
 * the remaining steps cost, and the work it reuses was already bought.
 */
export function ResumeRunAction({ runId }: { readonly runId: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const resume = async () => {
    if (pending) return;
    setPending(true);
    setMessage('Resuming…');
    const response = await fetch(`/api/runs/${runId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.ok) {
      location.reload();
      return;
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    // A conflict means this page is describing a run that has already moved
    // on -- someone resumed it in another tab, or a reconciler did. Showing
    // the stale page with an error beside a button that cannot work is worse
    // than showing what is actually true, so reload.
    if (response.status === 409) {
      setMessage('This run changed while you were looking at it; reloading…');
      location.reload();
      return;
    }
    setMessage(
      typeof body.error?.message === 'string'
        ? `Could not resume it: ${body.error.message}.`
        : 'Could not resume it.',
    );
    setPending(false);
  };
  return (
    <div className="action-stack">
      <div className="button-row">
        <button disabled={pending} onClick={() => void resume()} type="button">
          {pending ? 'Resuming…' : 'Resume'}
        </button>
      </div>
      <p aria-live="polite">{message}</p>
    </div>
  );
}

/** What the preview endpoints report back about one run's checkout. */
export interface RunPreviewView {
  readonly status: 'running' | 'no_server';
  readonly url?: string;
  readonly script?: string;
  readonly hint?: string;
}

async function previewFailure(
  response: Response,
  prefix: string,
): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  return typeof body.error?.message === 'string' && body.error.message !== ''
    ? `${prefix}: ${body.error.message}`
    : `${prefix}.`;
}

/**
 * Running the code a finished run delivered, on this machine, from the page
 * that describes it. A diff says whether the change reads correctly; only a
 * running copy says whether it works.
 *
 * Deliberately never reloads the page: starting a preview can take a minute,
 * and throwing the operator's scroll position away at the end of it -- or
 * worse, mid-install -- would be its own small betrayal. State moves in place.
 */
export function PreviewRunAction({
  runId,
  initialPreview,
}: {
  readonly runId: string;
  /** Seeds the rendered state; when absent the preview is fetched on mount. */
  readonly initialPreview?: RunPreviewView | null;
}) {
  // undefined: not yet known. null: no preview is running.
  const [preview, setPreview] = useState<RunPreviewView | null | undefined>(
    initialPreview,
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (initialPreview !== undefined) return;
    let abandoned = false;
    void (async () => {
      const response = await fetch(`/api/runs/${runId}/preview`).catch(
        () => undefined,
      );
      if (abandoned) return;
      setPreview(
        response !== undefined && response.ok
          ? ((await response.json()) as RunPreviewView)
          : null,
      );
    })();
    return () => {
      abandoned = true;
    };
  }, [initialPreview, runId]);

  const start = async () => {
    if (pending) return;
    setPending(true);
    setMessage('Starting it — the first run of a branch installs it first…');
    const response = await fetch(`/api/runs/${runId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.ok) {
      setPreview((await response.json()) as RunPreviewView);
      setMessage('');
    } else {
      setMessage(await previewFailure(response, 'Could not start the preview'));
    }
    setPending(false);
  };

  const stop = async () => {
    if (pending) return;
    setPending(true);
    setMessage('Stopping it…');
    const response = await fetch(`/api/runs/${runId}/preview`, {
      method: 'DELETE',
    });
    if (response.ok) {
      setPreview(null);
      setMessage('Preview stopped and its checkout removed.');
    } else {
      setMessage(await previewFailure(response, 'Could not stop the preview'));
    }
    setPending(false);
  };

  return (
    <div className="action-stack">
      {preview === undefined ? (
        <p>Checking for a running preview…</p>
      ) : preview === null ? (
        <div className="button-row">
          <button
            className="secondary"
            disabled={pending}
            onClick={() => void start()}
            type="button"
          >
            {pending ? 'Starting…' : 'Start preview'}
          </button>
        </div>
      ) : (
        <>
          {preview.status === 'running' && preview.url !== undefined ? (
            <p>
              <a href={preview.url} rel="noreferrer" target="_blank">
                {preview.url}
              </a>
              {preview.script === undefined ? null : (
                <>
                  {' — running '}
                  <code>{preview.script}</code>
                </>
              )}
            </p>
          ) : (
            <p>
              {preview.hint ??
                'The branch is checked out, but it declares nothing to serve.'}
            </p>
          )}
          <div className="button-row">
            <button
              className="secondary"
              disabled={pending}
              onClick={() => void stop()}
              type="button"
            >
              {pending ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        </>
      )}
      <p aria-live="polite">{message}</p>
    </div>
  );
}

export function RestartRunAction({ runId }: { readonly runId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const start = async () => {
    if (pending) return;
    setPending(true);
    setMessage('Starting…');
    const response = await fetch(`/api/runs/${runId}/restart`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
    });
    if (response.ok) {
      const run = (await response.json()) as { id?: string };
      if (typeof run.id === 'string') location.href = `/runs/${run.id}`;
      else location.reload();
      return;
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    setMessage(
      typeof body.error?.message === 'string'
        ? `Could not start it again: ${body.error.message}.`
        : 'Could not start it again.',
    );
    setPending(false);
  };
  return (
    <div className="action-stack">
      <div className="button-row">
        {confirming ? (
          <>
            <button
              disabled={pending}
              onClick={() => void start()}
              type="button"
            >
              {pending ? 'Starting…' : 'Confirm, start again'}
            </button>
            <button
              className="secondary"
              disabled={pending}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="secondary"
            onClick={() => setConfirming(true)}
            type="button"
          >
            Start again
          </button>
        )}
      </div>
      <p aria-live="polite">{message}</p>
    </div>
  );
}

/**
 * Stopping a run that will not finish on its own. The cancel endpoint writes
 * the terminal status and its event before it tells the worker, so this works
 * even when no worker is connected -- which is exactly when a run needs it.
 *
 * Two-step on purpose: cancelling is not reversible, and the runs list puts
 * this one click away from runs that are working fine.
 */
export function CancelRunAction({
  inboxHref,
  runId,
}: {
  readonly inboxHref?: string;
  readonly runId: string;
}) {
  const { message, mutate, pending, statusRef } = useMutation();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="action-stack">
      <div className="button-row">
        {confirming ? (
          <>
            <button
              disabled={pending}
              onClick={() => void mutate(`/api/runs/${runId}/cancel`, {})}
              type="button"
            >
              {pending ? 'Cancelling…' : 'Confirm cancel'}
            </button>
            <button
              className="secondary"
              disabled={pending}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Keep run
            </button>
          </>
        ) : (
          <>
            <button
              className="secondary"
              onClick={() => setConfirming(true)}
              type="button"
            >
              Cancel run
            </button>
            {inboxHref === undefined ? null : (
              <a className="button" href={inboxHref}>
                View Inbox
              </a>
            )}
          </>
        )}
      </div>
      {confirming && message === '' ? (
        <p>
          <small>
            This records the run as cancelled and stops any further work on it.
            Its history and provenance are kept. An approval still inside its
            window stays in the inbox until it lapses.
          </small>
        </p>
      ) : null}
      <p aria-live="polite" ref={statusRef} tabIndex={-1}>
        {message}
      </p>
    </div>
  );
}

export function ReplyForm({ messageId }: { readonly messageId: string }) {
  const { message, mutate, pending, statusRef } = useMutation({
    advanceSelection: false,
    resolvedKey: `question:${messageId}`,
  });
  const [reply, setReply] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void mutate(`/api/inbox/${messageId}/reply`, { reply });
      }}
    >
      <label htmlFor={`reply-${messageId}`}>Your reply</label>
      <textarea
        id={`reply-${messageId}`}
        maxLength={10_000}
        onChange={(event) => setReply(event.currentTarget.value)}
        required
        rows={4}
        value={reply}
      />
      <button disabled={pending} type="submit">
        {pending ? 'Sending…' : 'Send reply'}
      </button>
      <p aria-live="polite" ref={statusRef} tabIndex={-1}>
        {message}
      </p>
    </form>
  );
}
