import { listAccounts, resolveSelection } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { ReviewWorkbench } from '@/components/review/review-workbench';
import { PageHeader } from '@/components/stat-card';
import { getSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Review' };

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  const accounts = await listAccounts();
  const { selected, selectedId } = await resolveSelection(accounts);
  const [categories, settings] = await Promise.all([listCategories(), getSettings()]);

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
        dryRun={settings.dryRun}
        initialTab={searchParams.tab === 'attention' ? 'attention' : 'review'}
      />
    </>
  );
}
