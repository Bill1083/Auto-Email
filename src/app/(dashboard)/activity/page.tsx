import { listAccounts, resolveSelection } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { ActivityTable } from '@/components/activity/activity-table';
import { PageHeader } from '@/components/stat-card';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Activity' };

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const accounts = await listAccounts();
  const { selected, selectedId } = await resolveSelection(accounts);
  const categories = await listCategories(true);

  return (
    <>
      <PageHeader
        title="Activity"
        description={`Everything the pipeline did${selected ? ` in ${selected.email}` : ''}, with undo and corrections.`}
      />
      <ActivityTable
        selectedId={selectedId}
        categories={categories.map((c) => ({ key: c.key, name: c.name }))}
        initial={{
          view: searchParams.view === 'deleted' ? 'deleted' : 'all',
          q: searchParams.q ?? '',
          action: searchParams.action ?? '',
          category: searchParams.category ?? '',
          decidedBy: searchParams.decidedBy ?? '',
          status: searchParams.status ?? '',
          days: searchParams.days ?? '',
        }}
      />
    </>
  );
}
