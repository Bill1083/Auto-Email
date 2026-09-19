import { listAccounts, resolveSelection } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { ReviewWorkbench } from '@/components/review/review-workbench';
import { PageHeader } from '@/components/stat-card';
import { dryRunByAccount } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Review' };

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  const accounts = await listAccounts();
  const { selected, selectedId } = await resolveSelection(accounts);

  // Dry run is per mailbox, so the banner reflects whichever mailboxes are
  // in view: one of them, or any of them on the all-accounts view.
  const inScope = selected ? [selected] : accounts;
  const [categories, dryRunFlags] = await Promise.all([
    listCategories(),
    dryRunByAccount(inScope.map((account) => account.id)),
  ]);
  const dryRun = inScope.some((account) => dryRunFlags.get(account.id));

  return (
    <>
      <PageHeader
        title="Review"
        description={`Proposed deletions to confirm and emails flagged for you${
          selected ? ` in ${selected.email}` : ' across all mailboxes'
        }.`}
      />
      <ReviewWorkbench
        selectedId={selectedId}
        categories={categories.map((c) => ({ key: c.key, name: c.name }))}
        dryRun={dryRun}
        initialTab={searchParams.tab === 'attention' ? 'attention' : 'review'}
      />
    </>
  );
}
