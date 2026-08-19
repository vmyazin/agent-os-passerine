import { requirePageSession } from '../../src/auth/page-session';
import { SetupWizard } from '../../src/ui/setup-wizard';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  await requirePageSession();
  return <SetupWizard />;
}
