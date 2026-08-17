import { requirePageSession } from '../../src/auth/page-session';
import { loadConfigurationPageYaml } from '../../src/config/configuration-page-model';

export const dynamic = 'force-dynamic';

export default async function ConfigurationPage() {
  await requirePageSession();
  const yaml = await loadConfigurationPageYaml();
  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="configuration-title">
        <p className="eyebrow">Read only</p>
        <h1 id="configuration-title">Configuration</h1>
        <p>Canonical metadata for the active control-plane configuration.</p>
      </section>
      <pre className="configuration" aria-label="Canonical configuration YAML">
        <code>{yaml}</code>
      </pre>
    </div>
  );
}
