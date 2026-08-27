// app/inbox/page.tsx
import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState } from '../../src/ui/components';
import { InboxView } from '../../src/ui/inbox-view';
import { PageToolbar } from '../../src/ui/page-toolbar';
import { ProjectFilterChips } from '../../src/ui/project-filter-chips';
import { countInboxAttention } from '../../src/ui/rail-status-model';

export const dynamic = 'force-dynamic';

export default async function InboxPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ projectId?: string; runId?: string }>;
}) {
  await requirePageSession();
  const { projectId, runId } = await searchParams;
  const service = controlPlaneService();
  const [digest, projects] = await Promise.all([
    service.inboxDigest(50, projectId, runId),
    service.listProjects(),
  ]);
  const pendingCount = countInboxAttention(
    digest.approvals.filter((approval) => approval.status === 'pending'),
    digest.messages,
  );
  const isEmpty =
    digest.messages.length === 0 &&
    digest.approvals.length === 0 &&
    digest.notifications.length === 0;

  return (
    <div className="inbox-page">
      <PageToolbar
        action={
          pendingCount > 0 ? (
            <span className="mailbox-count">{pendingCount} pending</span>
          ) : undefined
        }
        description="Messages and updates from your agents."
        title="Inbox"
        titleId="inbox-title"
      />
      <ProjectFilterChips
        activeProjectId={projectId}
        basePath="/inbox"
        projects={projects}
      />
      {isEmpty ? (
        <EmptyState title="Inbox clear">
          Nothing needs your attention right now.
        </EmptyState>
      ) : (
        <InboxView
          digest={digest}
          {...(runId === undefined ? {} : { initialRunId: runId })}
          now={new Date().toISOString()}
        />
      )}
    </div>
  );
}
