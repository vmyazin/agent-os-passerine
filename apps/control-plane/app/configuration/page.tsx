// app/configuration/page.tsx
import { controlPlaneService } from '../../src/application/runtime';
import { DEFAULT_TIME_ZONE, supportedTimeZones } from '@agentos/core';
import { ServiceError } from '../../src/application/control-plane-service';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState } from '../../src/ui/components';
import { ConfigurationEditor } from '../../src/ui/configuration-editor';
import { PageToolbar } from '../../src/ui/page-toolbar';
import { ProjectFilterChips } from '../../src/ui/project-filter-chips';
import { redactConfigurationForDisplay } from '../../src/ui/redact-configuration';
import { TimeZoneSelector } from '../../src/ui/time-zone-selector';

export const dynamic = 'force-dynamic';

export default async function ConfigurationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ projectId?: string }>;
}) {
  const session = await requirePageSession();
  const { projectId: requestedProjectId } = await searchParams;
  const service = controlPlaneService();
  const projects = await service.listProjects();
  const currentTimeZone =
    (await service.getUserPreferences(session.login))?.timeZone ??
    DEFAULT_TIME_ZONE;
  const selectorProjectId =
    requestedProjectId ?? (projects.length === 1 ? projects[0]!.id : undefined);

  let yaml: string | undefined;
  let activeProjectId: string | undefined;
  let revisionLabel: string | undefined;

  if (selectorProjectId !== undefined) {
    try {
      const { active, projectId } = await service.getConfiguration(true, {
        projectId: selectorProjectId,
      });
      activeProjectId = projectId;
      if (active?.canonicalConfig !== undefined) {
        yaml = redactConfigurationForDisplay(active.canonicalConfig);
        revisionLabel = `Revision ${active.revision} · digest ${active.digest.slice(0, 12)}…`;
      }
    } catch (error) {
      if (!(
        error instanceof ServiceError && error.code === 'project_not_found'
      ))
        throw error;
    }
  }

  return (
    <div className="page-stack">
      <PageToolbar
        action={
          <span className="configuration-toolbar">
            {revisionLabel === undefined ? null : (
              <span className="project-count">{revisionLabel}</span>
            )}
            <ConfigurationEditor
              {...(selectorProjectId === undefined
                ? {}
                : { projectId: selectorProjectId })}
            />
          </span>
        }
        description="Canonical metadata for the selected project's applied configuration."
        title="Configuration"
        titleId="configuration-title"
      />
      <TimeZoneSelector
        currentTimeZone={currentTimeZone}
        timeZones={supportedTimeZones()}
      />
      <ProjectFilterChips
        activeProjectId={activeProjectId}
        basePath="/configuration"
        projects={projects}
      />
      {projects.length === 0 ? (
        <EmptyState title="No projects yet">
          Apply a configuration in <a href="/setup">Setup</a> first.
        </EmptyState>
      ) : selectorProjectId === undefined ? (
        <EmptyState title="Select a project">
          Choose a project above to view its applied configuration.
        </EmptyState>
      ) : yaml === undefined ? (
        <EmptyState title="No configuration applied">
          This project has no applied revision yet. Use{' '}
          <a href="/setup">Setup</a> to apply one.
        </EmptyState>
      ) : (
        <pre
          className="configuration"
          aria-label="Canonical configuration YAML"
        >
          <code>{yaml}</code>
        </pre>
      )}
    </div>
  );
}
