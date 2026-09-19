import { listAccounts, resolveSelection } from '@/lib/accounts';
import { guard, ok } from '@/lib/api';
import { getSettings } from '@/lib/settings';
import { overviewStats } from '@/lib/stats';

export const dynamic = 'force-dynamic';

/** GET /api/stats?accountId= — everything the Overview tiles and chart show. */
export async function GET(request: Request) {
  return guard(async () => {
    const accounts = await listAccounts();
    const param = new URL(request.url).searchParams.get('accountId');
    let accountId: string | null;
    if (param) {
      accountId = param === 'all' ? null : param;
    } else {
      accountId = (await resolveSelection(accounts)).selected?.id ?? null;
    }
    const settings = await getSettings();
    const stats = await overviewStats(accountId, accounts, settings);
    return ok({
      ...stats,
      lastRun: stats.lastRun
        ? { ...stats.lastRun, startedAt: stats.lastRun.startedAt.toISOString(), finishedAt: stats.lastRun.finishedAt?.toISOString() ?? null }
        : null,
      nextRunAt: stats.nextRunAt?.toISOString() ?? null,
    });
  }, 'GET /api/stats');
}
