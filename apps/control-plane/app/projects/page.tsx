// app/projects/page.tsx
import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { isLocalDirectoryPickerAvailable } from '../../src/local-system/directory-picker';
import { EmptyState } from '../../src/ui/components';
import { ImportProjectDialog } from '../../src/ui/import-project-dialog';
import { PageToolbar } from '../../src/ui/page-toolbar';
import { ProjectsTable } from '../../src/ui/projects-table';
import { loadUserTimeZone } from '../../src/ui/user-time-zone';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const session = await requirePageSession();
  const [projects, timeZone] = await Promise.all([
    controlPlaneService().listProjects(),
    loadUserTimeZone(session.login),
  ]);
  const projectCount = projects.length;
  const projectCountLabel =
    projectCount === 1 ? '1 project' : `${projectCount} projects`;

  return (
    <div className="page-stack">
      <PageToolbar
        action={
          <div className="project-toolbar-actions">
            <span className="project-count">{projectCountLabel}</span>
            <ImportProjectDialog
              localPickerAvailable={isLocalDirectoryPickerAvailable()}
            />
          </div>
        }
        description="Workspaces the control plane can run against."
        title="Projects"
        titleId="projects-title"
      />
      {projects.length === 0 ? (
        <EmptyState title="No projects yet">
          Import an existing repository, or apply a configuration in{' '}
          <a href="/setup">Setup</a> to register your first project.
        </EmptyState>
      ) : (
        <ProjectsTable projects={projects} timeZone={timeZone} />
      )}
    </div>
  );
}
