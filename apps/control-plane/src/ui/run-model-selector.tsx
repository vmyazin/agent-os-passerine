'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from './button';

/** The value that means "no global choice"; each project decides for itself. */
const PROJECT_DEFAULT = '';

export interface RunModelOptionView {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly available: boolean;
}

/**
 * Chooses the model every run uses.
 *
 * Options are grouped by provider, because that is how an operator thinks
 * about the choice and how credentials are held. A provider with no API key
 * on this deployment is shown but not selectable: hiding it would make a
 * missing key look like a missing feature.
 */
export function RunModelSelector({
  options,
  selectedId,
}: {
  readonly options: readonly RunModelOptionView[];
  readonly selectedId?: string;
}) {
  const router = useRouter();
  const current = selectedId ?? PROJECT_DEFAULT;
  const [choice, setChoice] = useState(current);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const chosen = options.find((option) => option.id === choice);
  const providers = [
    ...new Map(
      options.map((option) => [option.provider, option.providerLabel]),
    ),
  ];

  const save = async () => {
    if (pending || choice === current) return;
    setPending(true);
    setMessage('Saving…');
    try {
      const response = await fetch('/api/settings/run-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: choice === PROJECT_DEFAULT ? null : choice,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setMessage(body.error?.message ?? 'Could not save the model.');
        return;
      }
      setMessage('Saved. New runs will use it.');
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-labelledby="run-model-title" className="settings-panel">
      <div className="settings-panel-copy">
        <p className="eyebrow">Global setting</p>
        <h2 id="run-model-title">Run model</h2>
        <p>
          Every role in every new run uses this model. Runs already under way
          keep the model they started on.
        </p>
      </div>
      <div className="time-zone-control">
        <label htmlFor="run-model">Model</label>
        <select
          aria-describedby="run-model-detail run-model-message"
          id="run-model"
          onChange={(event) => {
            setChoice(event.target.value);
            setMessage('');
          }}
          value={choice}
        >
          <option value={PROJECT_DEFAULT}>
            Each project&rsquo;s own configuration
          </option>
          {providers.map(([provider, providerLabel]) => (
            <optgroup key={provider} label={providerLabel}>
              {options
                .filter((option) => option.provider === provider)
                .map((option) => (
                  <option
                    disabled={!option.available}
                    key={option.id}
                    value={option.id}
                  >
                    {option.label}
                    {option.available ? '' : ' — no API key configured'}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <p className="settings-preview" id="run-model-detail">
          {chosen === undefined
            ? 'Each project runs on the models its own configuration names.'
            : `Requests go to ${chosen.providerLabel} as ${chosen.model}.`}
        </p>
        <div className="button-row">
          <Button
            disabled={pending || choice === current}
            onClick={() => void save()}
          >
            {pending ? 'Saving…' : 'Save model'}
          </Button>
        </div>
        <p aria-live="polite" id="run-model-message">
          {message}
        </p>
      </div>
    </section>
  );
}
