// app/projects/page.tsx
import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState } from '../../src/ui/components';
import { ImportProjectDialog } from '../../src/ui/import-project-dialog';
import { PageToolbar } from '../../src/ui/page-toolbar';
import { ProjectsTable } from '../../src/ui/projects-table';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  await requirePageSession();
  const projects = await controlPlaneService().listProjects();
  const projectCount = projects.length;
  const projectCountLabel =
    projectCount === 1 ? '1 project' : `${projectCount} projects`;

  return (
    <div className="page-stack">
      <PageToolbar
        action={
          <div className="project-toolbar-actions">
            <span className="project-count">{projectCountLabel}</span>
            <ImportProjectDialog />
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
        <ProjectsTable projects={projects} />
      )}
    </div>
  );
}
