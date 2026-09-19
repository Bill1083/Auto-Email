/**
 * In-process scheduler.
 *
 * A one-minute tick checks every active account: if a configured run time
 * has passed since the account's last scheduled run, a full run starts; if
 * new-mail polling is on and enough minutes have elapsed, only the new-mail
 * lane runs. Started once per server process from `instrumentation.ts`.
 * Set SCHEDULER_ENABLED=false when host cron drives /api/jobs/run instead.
 */

import { env } from '@/lib/env';
import { runAccount } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';
import { defaultSettings, getSettingsForAccounts } from '@/lib/settings';
import { parseRunTimes, scheduledInstantsBetween } from '@/lib/time';

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  bootedAt: Date;
}

const globalState = globalThis as unknown as { __automailScheduler?: SchedulerState };

const TICK_MS = 60_000;

export function startScheduler(): void {
  if (!env.schedulerEnabled) {
    console.log('[automail] scheduler disabled by SCHEDULER_ENABLED=false');
    return;
  }
  if (globalState.__automailScheduler?.timer) return;

  const state: SchedulerState = { timer: null, ticking: false, bootedAt: new Date() };
  state.timer = setInterval(() => {
    void tick(state);
  }, TICK_MS);
  // Never keep the process alive just for the timer.
  state.timer.unref?.();
  globalState.__automailScheduler = state;
  console.log('[automail] scheduler started');
}

export function stopScheduler(): void {
  const state = globalState.__automailScheduler;
  if (state?.timer) clearInterval(state.timer);
  globalState.__automailScheduler = undefined;
}

export async function tick(state: SchedulerState, now = new Date()): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const accounts = await withDatabase(() =>
      prisma.account.findMany({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } }),
    );
    if (!accounts.ok) return;
    // Run times and polling are per mailbox, like every other setting.
    const perAccount = await getSettingsForAccounts(accounts.data.map((a) => a.id));

    for (const account of accounts.data) {
      const settings = perAccount.get(account.id) ?? defaultSettings();
      const times = parseRunTimes(settings.runTimes);
      // A restart must not replay every run time missed while the server was
      // down: the window starts at boot for accounts with no recorded run.
      const from = account.lastScheduledRunAt ?? state.bootedAt;
      const due = scheduledInstantsBetween(from, now, times).length > 0;

      if (due) {
        await withDatabase(() =>
          prisma.account.update({ where: { id: account.id }, data: { lastScheduledRunAt: now } }),
        );
        const outcome = await runAccount({ accountId: account.id, trigger: 'schedule', lane: 'both' });
        console.log(`[automail] scheduled run for ${account.email}: ${outcome.status} — ${outcome.message}`);
        continue;
      }

      if (settings.newMailPollMinutes > 0) {
        const last = account.lastNewLaneAt ?? account.createdAt;
        if (now.getTime() - last.getTime() >= settings.newMailPollMinutes * 60_000) {
          const outcome = await runAccount({ accountId: account.id, trigger: 'schedule', lane: 'new' });
          if (outcome.processed > 0) {
            console.log(`[automail] new-mail poll for ${account.email}: ${outcome.message}`);
          }
        }
      }
    }
  } catch (error) {
    console.error('[automail] scheduler tick failed:', error instanceof Error ? error.message : error);
  } finally {
    state.ticking = false;
  }
}
