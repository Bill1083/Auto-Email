import type { Run } from '@prisma/client';

import { listAccounts } from '@/lib/accounts';
import { fail, guard, ok } from '@/lib/api';
import type { BackgroundResponse, BackgroundRunDto } from '@/lib/background-text';
import { listJobs, serializeJob } from '@/lib/jobs';
import { isRunning } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** Finished runs worth telling the user about: the ones they started. */
const ANNOUNCED_TRIGGERS = ['manual', 'resume'];
const RECENT_MS = 24 * 3_600_000;

function serializeRun(run: Run, accountEmail: string): BackgroundRunDto {
  return {
    id: run.id,
    accountId: run.accountId,
    accountEmail,
    trigger: run.trigger,
    lane: run.lane,
    status: run.status,
    phase: run.phase,
    done: run.progressDone,
    total: run.progressTotal,
    processed: run.kept + run.archived + run.trashProposed + run.autoTrashed + run.attention,
    budget: run.budget,
    dryRun: run.dryRun,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * GET /api/background
 *
 * Everything working in the background across every mailbox (mail runs,
 * however they were started, and queued jobs), plus what finished in the
 * last day, so the dashboard can show progress on any page and say what
 * happened while it was closed.
 */
export async function GET() {
  return guard(async () => {
    const accounts = await listAccounts();
    const emailOf = new Map(accounts.map((account) => [account.id, account.email]));

    const result = await withDatabase(async () => {
      const since = new Date(Date.now() - RECENT_MS);
      const [running, finished, jobs] = await Promise.all([
        prisma.run.findMany({ where: { status: 'RUNNING' }, orderBy: { startedAt: 'asc' } }),
        prisma.run.findMany({
          where: { status: { not: 'RUNNING' }, trigger: { in: ANNOUNCED_TRIGGERS }, finishedAt: { gte: since } },
          orderBy: { finishedAt: 'desc' },
          take: 10,
        }),
        listJobs(),
      ]);
      return { running, finished, jobs };
    });
    if (!result.ok) return fail('The database could not be reached.', 503);

    const { running, finished, jobs } = result.data;
    const response: BackgroundResponse = {
      runs: {
        // The in-process lock is the authority: a row a restart left behind
        // as RUNNING is not actually working.
        active: running
          .filter((run) => isRunning(run.accountId))
          .map((run) => serializeRun(run, emailOf.get(run.accountId) ?? '')),
        recent: finished.map((run) => serializeRun(run, emailOf.get(run.accountId) ?? '')),
      },
      jobs: {
        active: jobs.active.map((job) => serializeJob(job, job.accountId ? (emailOf.get(job.accountId) ?? null) : null)),
        recent: jobs.recent.map((job) => serializeJob(job, job.accountId ? (emailOf.get(job.accountId) ?? null) : null)),
      },
    };
    return ok(response);
  }, 'GET /api/background');
}
