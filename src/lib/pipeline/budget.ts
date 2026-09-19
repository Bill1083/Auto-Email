/**
 * The daily cap.
 *
 * "Processed" means a Message row was written for it today, whether a rule
 * or the model decided it, so the mental model stays "at most N emails a day"
 * per account. The day boundary is midnight in APP_TIMEZONE.
 */

import type { Account } from '@prisma/client';

import { prisma, withDatabase } from '@/lib/prisma';
import type { AppSettings } from '@/lib/settings';
import { startOfDayUtc } from '@/lib/time';

export interface BudgetInput {
  dailyLimit: number;
  processedToday: number;
  /** 0 = no per-run ceiling beyond the daily cap. */
  maxPerRun: number;
}

export function computeBudget({ dailyLimit, processedToday, maxPerRun }: BudgetInput): number {
  const remaining = Math.max(0, dailyLimit - Math.max(0, processedToday));
  return maxPerRun > 0 ? Math.min(remaining, maxPerRun) : remaining;
}

export function effectiveDailyLimit(
  account: Pick<Account, 'dailyLimit'>,
  settings: Pick<AppSettings, 'dailyLimit'>,
): number {
  return account.dailyLimit ?? settings.dailyLimit;
}

export async function processedToday(accountId: string | null, now = new Date()): Promise<number> {
  const since = startOfDayUtc(now);
  const result = await withDatabase(() =>
    prisma.message.count({
      where: {
        ...(accountId ? { accountId } : {}),
        processedAt: { gte: since },
      },
    }),
  );
  return result.ok ? result.data : 0;
}

/** Days needed to clear `remaining` at `perDay`, or null when it never will. */
export function daysToClear(remaining: number, perDay: number): number | null {
  if (remaining <= 0) return 0;
  if (perDay <= 0) return null;
  return Math.ceil(remaining / perDay);
}
