// app/projects/page.tsx
import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState } from '../../src/ui/components';
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
        action={<span className="project-count">{projectCountLabel}</span>}
        description="Workspaces the control plane can run against."
        title="Projects"
        titleId="projects-title"
      />
      {projects.length === 0 ? (
        <EmptyState title="No projects yet">
          Apply a configuration in{' '}
          <a href="/setup">Setup</a> to register your first project.
        </EmptyState>
      ) : (
        <ProjectsTable projects={projects} />
      )}
    </div>
  );
}
