// app/projects/page.tsx
import { requirePageSession } from '../../src/auth/page-session';
import { PageToolbar } from '../../src/ui/page-toolbar';
import { PLACEHOLDER_PROJECTS } from '../../src/ui/projects-placeholder';
import { ProjectsTable } from '../../src/ui/projects-table';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  await requirePageSession();
  const projectCount = PLACEHOLDER_PROJECTS.length;
  const projectCountLabel =
    projectCount === 1 ? '1 project' : `${projectCount} projects`;

  return (
    <div className="page-stack">
      <PageToolbar
        action={<span className="project-count">{projectCountLabel}</span>}
        description="Placeholder inventory of workspaces the control plane can run against."
        title="Projects"
        titleId="projects-title"
      />
      <ProjectsTable projects={PLACEHOLDER_PROJECTS} />
    </div>
  );
}
