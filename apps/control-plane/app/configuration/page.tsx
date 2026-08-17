import { stringify } from 'yaml';

import { requirePageSession } from '../../src/auth/page-session';

export const dynamic = 'force-dynamic';

export default async function ConfigurationPage() {
  await requirePageSession();
  const metadata = {
    schema: 'agentos/v1',
    mode: 'read-only',
    source: 'agentos configuration',
    repository: process.env.AGENTOS_REPOSITORY ?? 'not configured',
    secrets: 'redacted',
  };
  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="configuration-title">
        <p className="eyebrow">Read only</p>
        <h1 id="configuration-title">Configuration</h1>
        <p>Canonical metadata for the active control-plane configuration.</p>
      </section>
      <pre className="configuration" aria-label="Canonical configuration YAML">
        <code>{stringify(metadata, { sortMapEntries: true })}</code>
      </pre>
    </div>
  );
}
