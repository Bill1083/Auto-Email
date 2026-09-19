import { listAccounts, resolveSelection } from '@/lib/accounts';
import { AppShell } from '@/components/app-shell';
import { describeIdentity } from '@/lib/auth';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeAccount } from '@/lib/serialize';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Every dashboard page shares the shell: the account switcher, navigation and
 * the review badge. The selected account comes from a cookie, so switching
 * mailboxes is one server render with no client-side data waterfall.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [accounts, session] = await Promise.all([listAccounts(), getSession()]);
  const { selected, selectedId } = await resolveSelection(accounts);
  const scope = selected ? { accountId: selected.id } : {};

  const counts = await withDatabase(async () => {
    const [review, attention] = await Promise.all([
      prisma.message.count({
        where: { ...scope, action: 'TRASH', status: { in: ['PENDING_REVIEW', 'DRY_RUN'] }, userAction: null },
      }),
      prisma.message.count({
        where: { ...scope, action: 'ATTENTION', attentionDoneAt: null, userAction: null, status: { not: 'REVERTED' } },
      }),
    ]);
    return review + attention;
  });

  return (
    <AppShell
      accounts={accounts.map(serializeAccount)}
      selectedId={selectedId}
      reviewCount={counts.ok ? counts.data : 0}
      identity={session ? describeIdentity(session.identity) : null}
    >
      {children}
    </AppShell>
  );
}
