// src/ui/start-run-form.tsx
'use client';

import { useEffect, useState } from 'react';

import { submittableCriteria } from './start-run-model';
import { Button } from './button';

/**
 * Starting work from the project that will own it.
 *
 * The form sends a title, a description, and for a goal its criteria. It
 * does not send provenance: the server fills that from the applied
 * revision, because the alternative is asking an operator to copy five
 * digests and a SHA out of another page.
 */
export function StartRunForm({
  projectId,
  configured,
  workflowBudgetMicrodollars,
  dailyBudgetMicrodollars,
  drift,
  baseRunId,
  label = 'Start a run',
}: {
  readonly projectId: string;
  readonly configured: boolean;
  readonly workflowBudgetMicrodollars?: number;
  readonly dailyBudgetMicrodollars?: number;
  readonly drift?: { readonly appliedSha: string; readonly headSha: string };
  readonly baseRunId?: string;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pipeline, setPipeline] = useState<'feature' | 'goal'>('feature');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [commands, setCommands] = useState<readonly string[]>([]);
  const [criteria, setCriteria] = useState<
    readonly { readonly description: string; readonly command: string }[]
  >([]);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open || pipeline !== 'goal' || commands.length > 0) return;
    void (async () => {
      try {
        const response = await fetch(
          `/api/goals/commands?projectId=${encodeURIComponent(projectId)}`,
        );
        if (!response.ok) return;
        const body = (await response.json()) as { commands?: string[] };
        const allowed = body.commands ?? [];
        setCommands(allowed);
        // A goal needs at least one criterion, so open with one rather than
        // an empty list the operator has to discover a button for.
        if (allowed[0] !== undefined && criteria.length === 0)
          setCriteria([{ description: '', command: allowed[0] }]);
      } catch {
        // The picker degrades to "no commands available"; submitting without
        // one is refused by the server with a message this form shows.
      }
    })();
  }, [open, pipeline, projectId, commands.length, criteria.length]);

  if (!configured)
    return (
      <p className="start-run-unconfigured">
        This project has no applied configuration yet, so there is nothing to
        pin a run to.{' '}
        <a href={`/setup?projectId=${encodeURIComponent(projectId)}`}>
          Apply one in Setup
        </a>
        .
      </p>
    );

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setMessage('Starting…');
    try {
      const response = await fetch(`/api/projects/${projectId}/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          pipeline,
          ...(baseRunId === undefined ? {} : { baseRunId }),
          ...(pipeline === 'goal'
            ? { criteria: submittableCriteria(criteria) }
            : {}),
        }),
      });
      if (response.ok) {
        const run = (await response.json()) as { id?: string };
        // Straight to the run: what the operator wants next is to watch it.
        if (typeof run.id === 'string') location.href = `/runs/${run.id}`;
        else location.reload();
        return;
      }
      // Prefer the server's sentence: these refusals are specific (a stale
      // chain, an unconfigured project, a command outside the allowlist) and
      // "try again" would be wrong for every one of them.
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setMessage(
        typeof body.error?.message === 'string'
          ? `Could not start: ${body.error.message}.`
          : 'Could not start this run.',
      );
    } finally {
      setPending(false);
    }
  };

  const money = (value: number | undefined) =>
    value === undefined ? undefined : `$${(value / 1_000_000).toFixed(2)}`;
  const workflowCap = money(workflowBudgetMicrodollars);
  const dailyCap = money(dailyBudgetMicrodollars);
  // The same function decides what is sent and whether sending is possible,
  // so the button cannot enable a request the server will reject.
  const ready =
    title.trim() !== '' &&
    description.trim() !== '' &&
    (pipeline === 'feature' || submittableCriteria(criteria).length > 0);

  if (!open) return <Button onClick={() => setOpen(true)}>{label}</Button>;

  return (
    <div className="start-run-form">
      {drift === undefined ? null : (
        <p className="start-run-drift">
          This run will build on <code>{drift.appliedSha.slice(0, 12)}</code>,
          the commit your configuration was applied against. The branch is now
          at <code>{drift.headSha.slice(0, 12)}</code> —{' '}
          <a href={`/setup?projectId=${encodeURIComponent(projectId)}`}>
            re-apply configuration
          </a>{' '}
          to build on the newer code.
        </p>
      )}
      <div className="button-row" role="group" aria-label="Run type">
        <Button
          aria-pressed={pipeline === 'feature'}
          variant={pipeline === 'feature' ? 'primary' : 'secondary'}
          onClick={() => setPipeline('feature')}
        >
          Feature
        </Button>
        <Button
          aria-pressed={pipeline === 'goal'}
          variant={pipeline === 'goal' ? 'primary' : 'secondary'}
          onClick={() => setPipeline('goal')}
        >
          Goal
        </Button>
      </div>
      <label>
        Title
        <input
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
      </label>
      <label>
        What should it build?
        <textarea
          maxLength={10_000}
          onChange={(event) => setDescription(event.target.value)}
          rows={4}
          value={description}
        />
      </label>
      {pipeline !== 'goal' ? null : (
        <fieldset className="start-run-criteria">
          <legend>Acceptance criteria</legend>
          <p className="start-run-hint">
            A goal is done when these commands pass. They are chosen from the
            project&apos;s trusted allowlist, never typed.
          </p>
          {criteria.map((criterion, index) => (
            <div className="start-run-criterion" key={index}>
              <input
                aria-label={`Criterion ${String(index + 1)} description`}
                maxLength={1_000}
                onChange={(event) =>
                  setCriteria((current) =>
                    current.map((entry, position) =>
                      position === index
                        ? { ...entry, description: event.target.value }
                        : entry,
                    ),
                  )
                }
                placeholder="What this proves"
                value={criterion.description}
              />
              <select
                aria-label={`Criterion ${String(index + 1)} command`}
                onChange={(event) =>
                  setCriteria((current) =>
                    current.map((entry, position) =>
                      position === index
                        ? { ...entry, command: event.target.value }
                        : entry,
                    ),
                  )
                }
                value={criterion.command}
              >
                {commands.map((command) => (
                  <option key={command} value={command}>
                    {command}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <Button
            variant="secondary"
            disabled={commands.length === 0 || criteria.length >= 20}
            onClick={() =>
              setCriteria((current) => [
                ...current,
                { description: '', command: commands[0] ?? '' },
              ])
            }
          >
            Add criterion
          </Button>
        </fieldset>
      )}
      {workflowCap === undefined ? null : (
        <p className="start-run-cost">
          This run may spend up to {workflowCap}
          {dailyCap === undefined
            ? ''
            : `, against ${dailyCap} for this project per day`}
          .
        </p>
      )}
      <div className="button-row">
        <Button disabled={pending || !ready} onClick={() => void submit()}>
          {pending ? 'Starting…' : 'Start run'}
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
      <p aria-live="polite">{message}</p>
    </div>
  );
}
