/**
 * Timezone helpers built on Intl only (no date library needed for this).
 *
 * "Today" for the daily cap and the scheduled run times are both defined in
 * APP_TIMEZONE, so a run at 23:30 local time still counts toward the right day.
 */

import { env } from '@/lib/env';

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let cached = partCache.get(tz);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partCache.set(tz, cached);
  }
  return cached;
}

export function zonedParts(date: Date, tz: string = env.timezone): ZonedParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some engines report midnight as 24 with hourCycle h23 on older ICU data.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Milliseconds the zone is ahead of UTC at the given instant. */
export function tzOffsetMs(date: Date, tz: string = env.timezone): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop sub-second noise so the arithmetic stays exact.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in the zone. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  tz: string = env.timezone,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = naive - tzOffsetMs(new Date(naive), tz);
  // Re-check once so a DST transition on that day is handled.
  const corrected = naive - tzOffsetMs(new Date(guess), tz);
  if (corrected !== guess) guess = corrected;
  return new Date(guess);
}

/** `YYYY-MM-DD` in the zone. */
export function dayKey(date: Date = new Date(), tz: string = env.timezone): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function startOfDayUtc(date: Date = new Date(), tz: string = env.timezone): Date {
  const p = zonedParts(date, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** The last `n` day keys ending today, oldest first. */
export function recentDayKeys(n: number, tz: string = env.timezone, now = new Date()): string[] {
  const keys: string[] = [];
  const todayStart = startOfDayUtc(now, tz);
  for (let i = n - 1; i >= 0; i -= 1) {
    // Noon avoids DST edge cases when stepping back whole days.
    keys.push(dayKey(new Date(todayStart.getTime() - i * 86_400_000 + 12 * 3_600_000), tz));
  }
  return keys;
}

export interface RunTime {
  hour: number;
  minute: number;
}

/** Parse `"07:00,19:00"`. Invalid entries are dropped; duplicates collapse. */
export function parseRunTimes(raw: string): RunTime[] {
  const seen = new Set<string>();
  const result: RunTime[] = [];
  for (const chunk of raw.split(/[,\s;]+/)) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(chunk.trim());
    if (!match) continue;
    const key = `${match[1].padStart(2, '0')}:${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ hour: Number(match[1]), minute: Number(match[2]) });
  }
  return result.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

export function formatRunTimes(times: RunTime[]): string {
  return times
    .map((t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`)
    .join(',');
}

/**
 * Every scheduled instant strictly after `from` and at or before `to`.
 * Used by the scheduler to decide whether a run is due.
 */
export function scheduledInstantsBetween(
  from: Date,
  to: Date,
  times: RunTime[],
  tz: string = env.timezone,
): Date[] {
  if (times.length === 0 || to <= from) return [];
  const instants: Date[] = [];
  // Walk day by day from the day containing `from` to the day containing `to`.
  let cursor = startOfDayUtc(from, tz);
  const end = startOfDayUtc(to, tz);
  while (cursor <= end) {
    const p = zonedParts(new Date(cursor.getTime() + 12 * 3_600_000), tz);
    for (const t of times) {
      const instant = zonedTimeToUtc(p.year, p.month, p.day, t.hour, t.minute, tz);
      if (instant > from && instant <= to) instants.push(instant);
    }
    cursor = new Date(cursor.getTime() + 36 * 3_600_000);
    cursor = startOfDayUtc(cursor, tz);
  }
  return instants.sort((a, b) => a.getTime() - b.getTime());
}

/** The next scheduled instant strictly after `after`. */
export function nextScheduledInstant(
  after: Date,
  times: RunTime[],
  tz: string = env.timezone,
): Date | null {
  if (times.length === 0) return null;
  const upcoming = scheduledInstantsBetween(after, addDays(after, 2), times, tz);
  return upcoming[0] ?? null;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function formatDateTime(date: Date | string, tz: string = env.timezone): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

export function formatDate(date: Date | string, tz: string = env.timezone): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** "3m ago", "2h ago", "5d ago". */
export function formatRelative(date: Date | string | null | undefined, now = new Date()): string {
  if (!date) return 'never';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = now.getTime() - d.getTime();
  if (!Number.isFinite(diff)) return '--';
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60_000) return 'in under a minute';
    if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)}m`;
    if (ahead < 86_400_000) return `in ${Math.round(ahead / 3_600_000)}h`;
    return `in ${Math.round(ahead / 86_400_000)}d`;
  }
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
