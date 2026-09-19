import { z } from 'zod';

import { getAccount, listAccounts } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { isRunning, runAccount, runAllAccounts } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeRun } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  accountId: z.string().min(1).max(64).default('all'),
  lane: z.enum(['new', 'backlog', 'both']).default('both'),
});

/**
 * POST /api/runs { accountId | "all", lane }
 *
 * Starts a run in the background and returns immediately; the page polls
 * GET /api/runs for progress.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    const { accountId, lane } = parsed.data;

    if (accountId === 'all') {
      const accounts = await listAccounts();
      const active = accounts.filter((a) => a.status === 'ACTIVE');
      if (active.length === 0) return fail('No active accounts to run.', 409);
      void runAllAccounts('manual', lane);
      return ok({ started: active.map((a) => a.id) }, { status: 202 });
    }

    const account = await getAccount(accountId);
    if (!account) return fail('No such account.', 404);
    if (account.status !== 'ACTIVE') {
      return fail(
        account.status === 'PAUSED' ? 'This account is paused.' : 'This account needs to be reconnected.',
        409,
      );
    }
    if (isRunning(account.id)) return ok({ started: [], alreadyRunning: true }, { status: 202 });
    void runAccount({ accountId: account.id, trigger: 'manual', lane });
    return ok({ started: [account.id] }, { status: 202 });
  }, 'POST /api/runs');
}

/** GET /api/runs?accountId=&limit= — recent runs, newest first. */
export async function GET(request: Request) {
  return guard(async () => {
    const url = new URL(request.url);
    const accountId = url.searchParams.get('accountId');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20));

    const result = await withDatabase(async () => {
      const runs = await prisma.run.findMany({
        where: accountId && accountId !== 'all' ? { accountId } : undefined,
        orderBy: { startedAt: 'desc' },
        take: limit,
        include: { account: { select: { email: true } } },
      });
      return runs;
    });
    if (!result.ok) return fail('The database could not be reached.', 503);

    return ok({
      runs: result.data.map((run) => ({
        ...serializeRun(run, run.account.email),
        running: isRunning(run.accountId) && run.status === 'RUNNING',
      })),
      running: result.data.some((run) => run.status === 'RUNNING' && isRunning(run.accountId)),
    });
  }, 'GET /api/runs');
}
