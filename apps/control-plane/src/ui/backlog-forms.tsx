// src/ui/backlog-forms.tsx
'use client';

import { useState } from 'react';

async function post(url: string, body: object): Promise<string | undefined> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (response.ok) return undefined;
  const parsed = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  return typeof parsed.error?.message === 'string'
    ? parsed.error.message
    : 'The request was refused.';
}

/** Pausing stops the next dispatch; it never touches work already running. */
export function BacklogStatusAction({
  backlogId,
  status,
}: {
  readonly backlogId: string;
  readonly status: 'active' | 'paused' | 'completed';
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  if (status === 'completed') return null;
  const next = status === 'active' ? 'paused' : 'active';
  const submit = async () => {
    if (pending) return;
    setPending(true);
    setMessage('');
    const failure = await post(`/api/backlogs/${backlogId}/status`, {
      status: next,
    });
    if (failure === undefined) location.reload();
    else {
      setMessage(failure);
      setPending(false);
    }
  };
  return (
    <span className="backlog-status-action">
      <button
        className="secondary"
        disabled={pending}
        onClick={() => void submit()}
        type="button"
      >
        {status === 'active' ? 'Pause' : 'Resume'}
      </button>
      <span aria-live="polite">{message}</span>
    </span>
  );
}

/**
 * Writing the list once is the whole point of a backlog, so the form takes
 * every item up front rather than making the operator add them one request
 * at a time.
 */
export function CreateBacklogForm({
  projectId,
}: {
  readonly projectId: string;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [items, setItems] = useState<
    readonly { readonly title: string; readonly description: string }[]
  >([
    { title: '', description: '' },
    { title: '', description: '' },
  ]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  const filled = items.filter(
    (item) => item.title.trim() !== '' && item.description.trim() !== '',
  );
  const ready = title.trim() !== '' && filled.length > 0;

  const submit = async () => {
    if (pending || !ready) return;
    setPending(true);
    setMessage('Creating…');
    const failure = await post('/api/backlogs', {
      projectId,
      title: title.trim(),
      // Half-written rows are drafts, not items: sending them would create
      // work nobody described.
      items: filled.map((item) => ({
        title: item.title.trim(),
        description: item.description.trim(),
      })),
    });
    if (failure === undefined) location.reload();
    else {
      setMessage(failure);
      setPending(false);
    }
  };

  if (!open)
    return (
      <button className="secondary" onClick={() => setOpen(true)} type="button">
        Create a backlog
      </button>
    );

  return (
    <div className="backlog-create">
      <p className="start-run-hint">
        The items run one at a time, each starting from the one before it, and
        each stopping for your approval. Nothing after a failure starts on its
        own.
      </p>
      <label>
        Backlog title
        <input
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
      </label>
      <ol className="backlog-create-items">
        {items.map((item, index) => (
          <li key={index}>
            <input
              aria-label={`Item ${String(index + 1)} title`}
              maxLength={200}
              onChange={(event) =>
                setItems((current) =>
                  current.map((entry, position) =>
                    position === index
                      ? { ...entry, title: event.target.value }
                      : entry,
                  ),
                )
              }
              placeholder="What to build"
              value={item.title}
            />
            <textarea
              aria-label={`Item ${String(index + 1)} description`}
              maxLength={10_000}
              onChange={(event) =>
                setItems((current) =>
                  current.map((entry, position) =>
                    position === index
                      ? { ...entry, description: event.target.value }
                      : entry,
                  ),
                )
              }
              placeholder="What it should do when it is done"
              rows={2}
              value={item.description}
            />
          </li>
        ))}
      </ol>
      <div className="button-row">
        <button
          className="secondary"
          disabled={items.length >= 50}
          onClick={() =>
            setItems((current) => [...current, { title: '', description: '' }])
          }
          type="button"
        >
          Add item
        </button>
        <button disabled={pending || !ready} onClick={() => void submit()} type="button">
          {pending ? 'Creating…' : `Create backlog (${String(filled.length)})`}
        </button>
        <button
          className="secondary"
          disabled={pending}
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
      <p aria-live="polite">{message}</p>
    </div>
  );
}
