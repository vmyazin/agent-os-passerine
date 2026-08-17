'use client';

import { useRef, useState } from 'react';

function useMutation() {
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
      setMessage(response.ok ? 'Saved.' : 'Could not save. Please try again.');
      statusRef.current?.focus();
      if (response.ok) location.reload();
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
  const { message, mutate, pending, statusRef } = useMutation();
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
          Approve
        </button>
        <button
          className="secondary"
          disabled={pending}
          onClick={() =>
            void mutate(`/api/approvals/${approvalId}/reject`, { scopeHash })
          }
          type="button"
        >
          Reject
        </button>
      </div>
      <p aria-live="polite" ref={statusRef} tabIndex={-1}>
        {message}
      </p>
    </div>
  );
}

export function ReplyForm({ messageId }: { readonly messageId: string }) {
  const { message, mutate, pending, statusRef } = useMutation();
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
