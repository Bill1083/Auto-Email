import { listAccounts, resolveSelection } from '@/lib/accounts';
import { fail, guard, ok } from '@/lib/api';
import { effectiveDailyLimit } from '@/lib/pipeline/budget';
import { isRunning } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';
import { getSettingsForAccounts } from '@/lib/settings';
import { startOfDayUtc } from '@/lib/time';

export const dynamic = 'force-dynamic';

export interface LiveRun {
  id: string;
  accountId: string;
  accountEmail: string;
  phase: string;
  done: number;
  /** 0 when the total is not yet known, which the UI shows as indefinite. */
  total: number;
  startedAt: string;
  dryRun: boolean;
}

export interface LiveResponse {
  run: LiveRun | null;
  awaitingReview: number;
  needsAttention: number;
  processedToday: number;
  dailyLimit: number;
  /** The most recent finished run, so the page can report the outcome once. */
  lastFinished: {
    id: string;
    status: string;
    error: string | null;
    fetched: number;
    dryRun: boolean;
  } | null;
}

/**
 * GET /api/live?accountId=
 *
 * The handful of numbers the Overview refreshes while a run is working: the
 * active run's progress and the counts that move as email is sorted. Kept
 * deliberately small because the page polls it every couple of seconds.
 */
export async function GET(request: Request) {
  return guard(async () => {
    const accounts = await listAccounts();
    const raw = new URL(request.url).searchParams.get('accountId');
    const accountId =
      raw && raw !== 'all' ? raw : raw === 'all' ? null : ((await resolveSelection(accounts)).selected?.id ?? null);
    if (accountId && !accounts.some((account) => account.id === accountId)) {
      return fail('No such account.', 404);
    }

    const scope = accountId ? { accountId } : {};
    const inScope = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
    const todayStart = startOfDayUtc();

    const data = await withDatabase(async () => {
      const [awaitingReview, needsAttention, processedToday, running, lastFinished] = await Promise.all([
        prisma.message.count({
          where: { ...scope, action: 'TRASH', status: { in: ['PENDING_REVIEW', 'DRY_RUN'] }, userAction: null },
        }),
        prisma.message.count({
          where: { ...scope, action: 'ATTENTION', attentionDoneAt: null, userAction: null, status: { not: 'REVERTED' } },
        }),
        prisma.message.count({ where: { ...scope, processedAt: { gte: todayStart } } }),
        prisma.run.findFirst({
          where: { ...scope, status: 'RUNNING' },
          orderBy: { startedAt: 'desc' },
          include: { account: { select: { email: true } } },
        }),
        prisma.run.findFirst({
          where: { ...scope, status: { not: 'RUNNING' } },
          orderBy: { startedAt: 'desc' },
        }),
      ]);
      return { awaitingReview, needsAttention, processedToday, running, lastFinished };
    });

    if (!data.ok) return fail('The database could not be reached.', 503);
    const { running } = data.data;

    const settings = await getSettingsForAccounts(inScope.map((account) => account.id));
    const dailyLimit = inScope.reduce((sum, account) => {
      const scoped = settings.get(account.id);
      return sum + (scoped ? effectiveDailyLimit(account, scoped) : 0);
    }, 0);

    // A row left as RUNNING by a restarted container is not actually working,
    // so the in-process lock decides whether to show a live bar.
    const live = running && isRunning(running.accountId) ? running : null;

    const response: LiveResponse = {
      run: live
        ? {
            id: live.id,
            accountId: live.accountId,
            accountEmail: live.account.email,
            phase: live.phase,
            done: live.progressDone,
            total: live.progressTotal,
            startedAt: live.startedAt.toISOString(),
            dryRun: live.dryRun,
          }
        : null,
      awaitingReview: data.data.awaitingReview,
      needsAttention: data.data.needsAttention,
      processedToday: data.data.processedToday,
      dailyLimit,
      lastFinished: data.data.lastFinished
        ? {
            id: data.data.lastFinished.id,
            status: data.data.lastFinished.status,
            error: data.data.lastFinished.error,
            fetched: data.data.lastFinished.fetched,
            dryRun: data.data.lastFinished.dryRun,
          }
        : null,
    };
    return ok(response);
  }, 'GET /api/live');
}
