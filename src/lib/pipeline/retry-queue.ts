/**
 * Mailboxes with emails left for later because Gemini was busy, and when to
 * try them again.
 *
 * Kept in memory on purpose. The emails themselves were never recorded, so
 * the lanes offer them again on any later run; this only decides how soon
 * that run comes. After a restart the next scheduled run does the same job.
 */

/** Minutes to wait after the 1st, 2nd, 3rd... consecutive busy run. */
const STEPS_MINUTES = [10, 20, 40, 60];

interface Pending {
  at: number;
  /** Consecutive runs that had to leave emails for later. */
  streak: number;
}

const globalStore = globalThis as unknown as { __automailRetries?: Map<string, Pending> };

function store(): Map<string, Pending> {
  globalStore.__automailRetries ??= new Map();
  return globalStore.__automailRetries;
}

/** How long to wait after `streak` busy runs in a row. Pure, for tests. */
export function retryDelayMinutes(streak: number): number {
  return STEPS_MINUTES[Math.min(Math.max(streak, 1), STEPS_MINUTES.length) - 1];
}

/** Book a follow-up run, backing off if the last one was busy too. */
export function scheduleRetry(accountId: string, now = Date.now()): Date {
  const streak = (store().get(accountId)?.streak ?? 0) + 1;
  const at = now + retryDelayMinutes(streak) * 60_000;
  store().set(accountId, { at, streak });
  return new Date(at);
}

/** A run that classified everything it fetched resets the backoff. */
export function clearRetry(accountId: string): void {
  store().delete(accountId);
}

export function nextRetryAt(accountId: string): Date | null {
  const pending = store().get(accountId);
  return pending ? new Date(pending.at) : null;
}

export interface LiveRetry {
  at: string;
  accountEmail: string;
}

/** The soonest booked retry among these mailboxes, for the dashboard. */
export function soonestRetry(accounts: { id: string; email: string }[]): LiveRetry | null {
  let soonest: LiveRetry | null = null;
  for (const account of accounts) {
    const at = nextRetryAt(account.id);
    if (at && (!soonest || at.toISOString() < soonest.at)) {
      soonest = { at: at.toISOString(), accountEmail: account.email };
    }
  }
  return soonest;
}

/** Accounts whose follow-up is due. They stay booked until their run reports back. */
export function dueRetries(now = Date.now()): string[] {
  return [...store().entries()].filter(([, pending]) => pending.at <= now).map(([id]) => id);
}
