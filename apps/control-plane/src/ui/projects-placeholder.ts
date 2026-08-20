// src/ui/projects-placeholder.ts
export type PlaceholderProjectStatus =
  'running' | 'waiting' | 'succeeded' | 'failed';

export interface PlaceholderProject {
  readonly id: string;
  readonly name: string;
  readonly repository: string;
  readonly lastRunStatus: PlaceholderProjectStatus;
  readonly updatedAt: string;
}

export const PLACEHOLDER_PROJECTS: readonly PlaceholderProject[] = [
  {
    id: 'project_passerine',
    name: 'Agent OS Passerine',
    repository: 'github.com/team-zork/agent-os-passerine',
    lastRunStatus: 'running',
    updatedAt: 'Aug 19, 2026',
  },
  {
    id: 'project_e2e',
    name: 'E2E Project',
    repository: 'local/e2e-project',
    lastRunStatus: 'waiting',
    updatedAt: 'Aug 17, 2026',
  },
  {
    id: 'project_billing',
    name: 'Billing Gateway',
    repository: 'github.com/acme/billing-gateway',
    lastRunStatus: 'succeeded',
    updatedAt: 'Aug 18, 2026',
  },
  {
    id: 'project_docs',
    name: 'Docs Site',
    repository: 'github.com/acme/docs',
    lastRunStatus: 'failed',
    updatedAt: 'Aug 16, 2026',
  },
  {
    id: 'project_cli',
    name: 'Internal CLI',
    repository: 'local/internal-cli',
    lastRunStatus: 'succeeded',
    updatedAt: 'Aug 15, 2026',
  },
];
