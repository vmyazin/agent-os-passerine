'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface ProviderCredentialView {
  readonly provider: string;
  readonly providerLabel: string;
  readonly apiKeyVariable: string;
  readonly source: 'database' | 'environment' | 'none';
  readonly hint?: string;
  readonly updatedAt?: string;
}

function describe(credential: ProviderCredentialView): string {
  switch (credential.source) {
    case 'database':
      return credential.hint === undefined
        ? 'Stored here, encrypted.'
        : `Stored here, encrypted · ends ${credential.hint}`;
    case 'environment':
      return `From ${credential.apiKeyVariable} in the environment.`;
    default:
      return 'No key. This provider cannot run.';
  }
}

/**
 * Adds, replaces and removes the API key each model provider runs on.
 *
 * The field is emptied the moment a key is submitted and no response ever
 * carries one back, so a key is on this page only while it is being typed.
 * What is shown instead is where the key comes from and its last four
 * characters, which is enough to recognise a credential and not enough to
 * use one.
 */
export function ProviderKeySettings({
  credentials,
}: {
  readonly credentials: readonly ProviderCredentialView[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  const send = async (provider: string, init: RequestInit) => {
    setPending(true);
    try {
      const response = await fetch(
        `/api/settings/provider-keys/${encodeURIComponent(provider)}`,
        init,
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setMessage(body.error?.message ?? 'Could not save the key.');
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setPending(false);
    }
  };

  const save = async (provider: string) => {
    if (pending || apiKey.trim() === '') return;
    setMessage('Saving…');
    const key = apiKey;
    // Cleared before the request resolves: the value has no reason to stay in
    // the field, and a failed save should not leave it sitting there.
    setApiKey('');
    if (
      await send(provider, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      })
    ) {
      setEditing(undefined);
      setMessage('Saved. Runs will use it from now on.');
    }
  };

  const remove = async (provider: string) => {
    if (pending) return;
    setMessage('Removing…');
    if (await send(provider, { method: 'DELETE' }))
      setMessage('Removed. Any environment variable applies again.');
  };

  return (
    <section aria-labelledby="provider-keys-title" className="settings-panel">
      <div className="settings-panel-copy">
        <p className="eyebrow">Global setting</p>
        <h2 id="provider-keys-title">Provider API keys</h2>
        <p>
          Stored encrypted in the database. A key saved here is used instead of
          the matching environment variable, and takes effect on the next run.
        </p>
      </div>
      <div className="provider-key-list">
        {credentials.map((credential) => (
          <div className="provider-key" key={credential.provider}>
            <div className="provider-key-identity">
              <strong>{credential.providerLabel}</strong>
              <span className={`provider-key-source ${credential.source}`}>
                {describe(credential)}
              </span>
            </div>
            {editing === credential.provider ? (
              <div className="provider-key-entry">
                <label htmlFor={`api-key-${credential.provider}`}>
                  {credential.providerLabel} API key
                </label>
                <input
                  autoComplete="off"
                  id={`api-key-${credential.provider}`}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Paste the key"
                  spellCheck={false}
                  type="password"
                  value={apiKey}
                />
                <div className="button-row">
                  <button
                    disabled={pending || apiKey.trim() === ''}
                    onClick={() => void save(credential.provider)}
                    type="button"
                  >
                    {pending ? 'Saving…' : 'Save key'}
                  </button>
                  <button
                    className="secondary"
                    disabled={pending}
                    onClick={() => {
                      setApiKey('');
                      setEditing(undefined);
                      setMessage('');
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={() => {
                    setApiKey('');
                    setMessage('');
                    setEditing(credential.provider);
                  }}
                  type="button"
                >
                  {credential.source === 'database' ? 'Replace key' : 'Add key'}
                </button>
                {credential.source === 'database' ? (
                  <button
                    className="secondary"
                    disabled={pending}
                    onClick={() => void remove(credential.provider)}
                    type="button"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ))}
        <p aria-live="polite" id="provider-key-message">
          {message}
        </p>
      </div>
    </section>
  );
}
