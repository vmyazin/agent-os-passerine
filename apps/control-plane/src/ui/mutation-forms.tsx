'use client';

import { useRef, useState } from 'react';
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
            <button disabled={pending} onClick={() => void start()} type="button">
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
