/**
 * Numbers for the Overview and Settings pages.
 */

import type { Account, Run } from '@prisma/client';

import { daysToClear, effectiveDailyLimit } from '@/lib/pipeline/budget';
import { projectedCost } from '@/lib/pipeline/cost';
import { prisma, withDatabase } from '@/lib/prisma';
import type { AppSettings } from '@/lib/settings';
import {
  dayKey,
  nextScheduledInstant,
  parseRunTimes,
  recentDayKeys,
  startOfDayUtc,
  zonedParts,
  zonedTimeToUtc,
} from '@/lib/time';

export interface DaySeries {
  day: string;
  kept: number;
  archived: number;
  trashed: number;
  attention: number;
}

export interface CostSummary {
  today: number;
  month: number;
  lifetime: number;
  avgPerEmail7d: number | null;
  avgPerEmailLifetime: number | null;
  aiEmails7d: number;
  aiEmailsLifetime: number;
  calls7d: number;
  tokens7d: number;
}

export interface OverviewStats {
  processedToday: number;
  dailyLimit: number;
  awaitingReview: number;
  needsAttention: number;
  /** Null until the backlog snapshot exists. */
  backlogRemaining: number | null;
  backlogDaysToClear: number | null;
  projectedBacklogCost: number | null;
  totalProcessed: number;
  totalTrashed: number;
  cost: CostSummary;
  series: DaySeries[];
  lastRun: Run | null;
  nextRunAt: Date | null;
  accountsNeedingReauth: number;
  dryRun: boolean;
}

function scope(accountId: string | null) {
  return accountId ? { accountId } : {};
}

export async function costSummary(accountId: string | null, now = new Date()): Promise<CostSummary> {
  const todayStart = startOfDayUtc(now);
  const p = zonedParts(now);
  const monthStart = zonedTimeToUtc(p.year, p.month, 1, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const result = await withDatabase(async () => {
    const [today, month, lifetime, week, lifetimeClassify] = await Promise.all([
      prisma.aiCall.aggregate({ where: { ...scope(accountId), createdAt: { gte: todayStart } }, _sum: { costUsd: true } }),
      prisma.aiCall.aggregate({ where: { ...scope(accountId), createdAt: { gte: monthStart } }, _sum: { costUsd: true } }),
      prisma.aiCall.aggregate({ where: scope(accountId), _sum: { costUsd: true } }),
      prisma.aiCall.aggregate({
        where: { ...scope(accountId), purpose: 'classify', ok: true, createdAt: { gte: weekAgo } },
        _sum: { costUsd: true, emailCount: true, promptTokens: true, outputTokens: true, thoughtTokens: true },
        _count: { _all: true },
      }),
      prisma.aiCall.aggregate({
        where: { ...scope(accountId), purpose: 'classify', ok: true },
        _sum: { costUsd: true, emailCount: true },
      }),
    ]);
    return { today, month, lifetime, week, lifetimeClassify };
  });

  if (!result.ok) {
    return {
      today: 0,
      month: 0,
      lifetime: 0,
      avgPerEmail7d: null,
      avgPerEmailLifetime: null,
      aiEmails7d: 0,
      aiEmailsLifetime: 0,
      calls7d: 0,
      tokens7d: 0,
    };
  }
  const { today, month, lifetime, week, lifetimeClassify } = result.data;
  const weekEmails = week._sum.emailCount ?? 0;
  const lifeEmails = lifetimeClassify._sum.emailCount ?? 0;
  return {
    today: today._sum.costUsd ?? 0,
    month: month._sum.costUsd ?? 0,
    lifetime: lifetime._sum.costUsd ?? 0,
    avgPerEmail7d: weekEmails > 0 ? (week._sum.costUsd ?? 0) / weekEmails : null,
    avgPerEmailLifetime: lifeEmails > 0 ? (lifetimeClassify._sum.costUsd ?? 0) / lifeEmails : null,
    aiEmails7d: weekEmails,
    aiEmailsLifetime: lifeEmails,
    calls7d: week._count._all,
    tokens7d:
      (week._sum.promptTokens ?? 0) + (week._sum.outputTokens ?? 0) + (week._sum.thoughtTokens ?? 0),
  };
}

export async function overviewStats(
  accountId: string | null,
  accounts: Account[],
  settings: AppSettings,
  now = new Date(),
): Promise<OverviewStats> {
  const todayStart = startOfDayUtc(now);
  const days = recentDayKeys(14, undefined, now);
  const seriesStart = startOfDayUtc(new Date(now.getTime() - 13 * 86_400_000));
  const scoped = accountId ? accounts.filter((a) => a.id === accountId) : accounts;

  const data = await withDatabase(async () => {
    const [processedToday, awaitingReview, needsAttention, totalProcessed, totalTrashed, recent, lastRun, backlogPending] =
      await Promise.all([
        prisma.message.count({ where: { ...scope(accountId), processedAt: { gte: todayStart } } }),
        prisma.message.count({
          where: {
            ...scope(accountId),
            action: 'TRASH',
            status: { in: ['PENDING_REVIEW', 'DRY_RUN'] },
            userAction: null,
          },
        }),
        prisma.message.count({
          where: {
            ...scope(accountId),
            action: 'ATTENTION',
            attentionDoneAt: null,
            userAction: null,
            status: { not: 'REVERTED' },
          },
        }),
        prisma.message.count({ where: scope(accountId) }),
        prisma.message.count({ where: { ...scope(accountId), status: 'TRASHED' } }),
        prisma.message.findMany({
          where: { ...scope(accountId), processedAt: { gte: seriesStart } },
          select: { processedAt: true, action: true, userAction: true },
        }),
        prisma.run.findFirst({ where: scope(accountId), orderBy: { startedAt: 'desc' } }),
        prisma.backlogItem.count({ where: { ...scope(accountId), status: 'PENDING' } }),
      ]);
    return { processedToday, awaitingReview, needsAttention, totalProcessed, totalTrashed, recent, lastRun, backlogPending };
  });

  const cost = await costSummary(accountId, now);

  const series: DaySeries[] = days.map((day) => ({ day, kept: 0, archived: 0, trashed: 0, attention: 0 }));
  const byDay = new Map(series.map((s) => [s.day, s]));
  if (data.ok) {
    for (const row of data.data.recent) {
      const entry = byDay.get(dayKey(row.processedAt));
      if (!entry) continue;
      const action = row.userAction ?? row.action;
      if (action === 'KEEP') entry.kept += 1;
      else if (action === 'ARCHIVE') entry.archived += 1;
      else if (action === 'TRASH') entry.trashed += 1;
      else if (action === 'ATTENTION') entry.attention += 1;
    }
  }

  const dailyLimit = scoped.reduce((sum, account) => sum + effectiveDailyLimit(account, settings), 0);
  const anySnapshot = scoped.some((a) => a.backlogBuiltAt);
  const backlogRemaining = anySnapshot && data.ok ? data.data.backlogPending : null;
  const perDay = dailyLimit;

  const times = parseRunTimes(settings.runTimes);

  return {
    processedToday: data.ok ? data.data.processedToday : 0,
    dailyLimit,
    awaitingReview: data.ok ? data.data.awaitingReview : 0,
    needsAttention: data.ok ? data.data.needsAttention : 0,
    backlogRemaining,
    backlogDaysToClear: backlogRemaining === null ? null : daysToClear(backlogRemaining, perDay),
    projectedBacklogCost:
      backlogRemaining === null ? null : projectedCost(backlogRemaining, cost.avgPerEmailLifetime),
    totalProcessed: data.ok ? data.data.totalProcessed : 0,
    totalTrashed: data.ok ? data.data.totalTrashed : 0,
    cost,
    series,
    lastRun: data.ok ? data.data.lastRun : null,
    nextRunAt: nextScheduledInstant(now, times),
    accountsNeedingReauth: scoped.filter((a) => a.status === 'NEEDS_REAUTH').length,
    dryRun: settings.dryRun,
  };
}
