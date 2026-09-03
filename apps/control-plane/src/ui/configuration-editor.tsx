// src/ui/configuration-editor.tsx
'use client';

import { useState } from 'react';
import { Button } from './button';

interface PlanChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}

interface Plan {
  readonly changed: boolean;
  readonly fromRevision: number | null;
  readonly changes: readonly PlanChange[];
}

/**
 * Editing configuration in the browser, with the diff the CLI's `config plan`
 * prints.
 *
 * The editor starts empty and stays that way: the stored configuration is
 * never echoed back to a session, because `environments[].variables` is a
 * free-form map that may hold credentials. What can be shown safely is the
 * difference between what is about to be sent and what is applied -- which
 * is the part an operator actually needs before pressing apply.
 */
export function ConfigurationEditor({
  projectId,
}: {
  readonly projectId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [yaml, setYaml] = useState('');
  const [plan, setPlan] = useState<Plan | undefined>(undefined);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  const failure = async (response: Response) => {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    return typeof body.error?.message === 'string'
      ? body.error.message
      : 'The request was refused.';
  };

  const runPlan = async () => {
    if (pending || yaml.trim() === '') return;
    setPending(true);
    setMessage('');
    setPlan(undefined);
    try {
      const response = await fetch('/api/configuration/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml }),
      });
      if (response.ok) setPlan((await response.json()) as Plan);
      else setMessage(await failure(response));
    } finally {
      setPending(false);
    }
  };

  const apply = async () => {
    if (pending || yaml.trim() === '') return;
    setPending(true);
    setMessage('Applying…');
    try {
      const response = await fetch('/api/setup/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ yaml }),
      });
      if (response.ok) {
        location.reload();
        return;
      }
      setMessage(await failure(response));
    } finally {
      setPending(false);
    }
  };

  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Change configuration
      </Button>
    );

  return (
    <div className="configuration-editor">
      <p className="start-run-hint">
        Paste the configuration you want applied. The editor does not start from
        the stored copy: it is withheld from the browser because environment
        variables may carry credentials. Plan first to see exactly what would
        change.
      </p>
      <label>
        Configuration YAML
        <textarea
          className="code-field"
          onChange={(event) => {
            setYaml(event.target.value);
            // A plan describes the text it was run against; keeping a stale
            // one on screen while the text moves under it is how an operator
            // applies something they did not read.
            setPlan(undefined);
          }}
          rows={16}
          spellCheck={false}
          value={yaml}
        />
      </label>
      {plan === undefined ? null : (
        <div className="configuration-plan">
          {plan.fromRevision === null ? (
            <p>
              This binding has no applied revision yet, so applying creates the
              project and its first revision.
            </p>
          ) : plan.changed ? (
            <>
              <p>
                {plan.changes.length === 1
                  ? '1 change'
                  : `${String(plan.changes.length)} changes`}{' '}
                against revision {plan.fromRevision}:
              </p>
              <ul>
                {plan.changes.map((change) => (
                  <li key={`${change.kind}:${change.path}`}>
                    <code>{change.path}</code>{' '}
                    <span className={`plan-kind plan-kind-${change.kind}`}>
                      {change.kind}
                    </span>
                    {change.before === undefined && change.after === undefined
                      ? null
                      : ` · ${change.before ?? '—'} → ${change.after ?? '—'}`}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              Identical to revision {plan.fromRevision}. Applying would change
              nothing.
            </p>
          )}
        </div>
      )}
      <div className="button-row">
        <Button
          variant="secondary"
          disabled={pending || yaml.trim() === ''}
          onClick={() => void runPlan()}
        >
          {pending ? 'Working…' : 'Plan'}
        </Button>
        <Button
          disabled={pending || yaml.trim() === ''}
          onClick={() => void apply()}
        >
          Apply
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setPlan(undefined);
            setMessage('');
          }}
        >
          Cancel
        </Button>
      </div>
      <p aria-live="polite">{message}</p>
      {projectId === undefined ? null : (
        <p className="start-run-hint">
          Applying a configuration whose binding matches this project appends a
          revision to it; a different binding creates a separate project.
        </p>
      )}
    </div>
  );
}
