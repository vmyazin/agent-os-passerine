import { requirePageSession } from '../../src/auth/page-session';
import { loadConfigurationPageYaml } from '../../src/config/configuration-page-model';
import { PageToolbar } from '../../src/ui/page-toolbar';

export const dynamic = 'force-dynamic';

export default async function ConfigurationPage() {
  await requirePageSession();
  const yaml = await loadConfigurationPageYaml();
  return (
    <div className="page-stack">
      <PageToolbar
        description="Canonical metadata for the active control-plane configuration."
        title="Configuration"
        titleId="configuration-title"
      />
      <pre className="configuration" aria-label="Canonical configuration YAML">
        <code>{yaml}</code>
      </pre>
    </div>
  );
}
