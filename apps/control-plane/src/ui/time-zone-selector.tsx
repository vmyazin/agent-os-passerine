'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { formatDisplayDateTime } from './format-timestamp';
import { Button } from './button';

export function TimeZoneSelector({
  currentTimeZone,
  timeZones,
}: {
  readonly currentTimeZone: string;
  readonly timeZones: readonly string[];
}) {
  const router = useRouter();
  const [timeZone, setTimeZone] = useState(currentTimeZone);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const valid = timeZones.includes(timeZone);

  const save = async () => {
    if (pending || !valid || timeZone === currentTimeZone) return;
    setPending(true);
    setMessage('Saving…');
    try {
      const response = await fetch('/api/preferences/time-zone', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeZone }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setMessage(body.error?.message ?? 'Could not save the time zone.');
        return;
      }
      setMessage('Saved. Updating displayed times…');
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-labelledby="operator-time-title" className="settings-panel">
      <div className="settings-panel-copy">
        <p className="eyebrow">Operator preference</p>
        <h2 id="operator-time-title">Operator time</h2>
        <p>
          Dates, run activity, Inbox messages, and greetings use this timezone
          everywhere in Agent OS.
        </p>
      </div>
      <div className="time-zone-control">
        <label htmlFor="operator-time-zone">Timezone</label>
        <input
          aria-describedby="time-zone-preview time-zone-message"
          autoComplete="off"
          id="operator-time-zone"
          list="operator-time-zones"
          onChange={(event) => {
            setTimeZone(event.target.value);
            setMessage('');
          }}
          spellCheck={false}
          value={timeZone}
        />
        <datalist id="operator-time-zones">
          {timeZones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <p className="settings-preview" id="time-zone-preview">
          Preview ·{' '}
          {valid
            ? formatDisplayDateTime(new Date().toISOString(), timeZone)
            : 'Choose a timezone from the list.'}
        </p>
        <div className="button-row">
          <Button
            disabled={pending || !valid || timeZone === currentTimeZone}
            onClick={() => void save()}
          >
            {pending ? 'Saving…' : 'Save timezone'}
          </Button>
        </div>
        <p aria-live="polite" id="time-zone-message">
          {message}
        </p>
      </div>
    </section>
  );
}
