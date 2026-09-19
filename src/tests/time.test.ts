import { describe, expect, it } from 'vitest';

import {
  dayKey,
  formatRunTimes,
  nextScheduledInstant,
  parseRunTimes,
  recentDayKeys,
  scheduledInstantsBetween,
  startOfDayUtc,
  zonedTimeToUtc,
} from '@/lib/time';

const LONDON = 'Europe/London';
const SYDNEY = 'Australia/Sydney';

describe('parseRunTimes', () => {
  it('parses, sorts, deduplicates and drops junk', () => {
    expect(parseRunTimes('19:00, 07:00,7:00,25:00,abc')).toEqual([
      { hour: 7, minute: 0 },
      { hour: 19, minute: 0 },
    ]);
    expect(formatRunTimes(parseRunTimes('19:00,07:00'))).toBe('07:00,19:00');
  });

  it('returns nothing for an empty string', () => {
    expect(parseRunTimes('')).toEqual([]);
  });
});

describe('dayKey and startOfDayUtc', () => {
  it('uses the zone, not UTC, to decide which day it is', () => {
    const instant = new Date('2026-01-01T13:30:00Z');
    expect(dayKey(instant, 'UTC')).toBe('2026-01-01');
    expect(dayKey(instant, SYDNEY)).toBe('2026-01-02');
  });

  it('finds local midnight as a UTC instant', () => {
    expect(startOfDayUtc(new Date('2026-07-15T15:00:00Z'), LONDON).toISOString()).toBe('2026-07-14T23:00:00.000Z');
    expect(startOfDayUtc(new Date('2026-01-15T15:00:00Z'), LONDON).toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });
});

describe('zonedTimeToUtc', () => {
  it('handles the DST change day', () => {
    // Clocks go forward at 01:00 UTC on 2025-03-30 in London.
    expect(zonedTimeToUtc(2025, 3, 29, 12, 0, LONDON).toISOString()).toBe('2025-03-29T12:00:00.000Z');
    expect(zonedTimeToUtc(2025, 3, 30, 12, 0, LONDON).toISOString()).toBe('2025-03-30T11:00:00.000Z');
  });
});

describe('scheduledInstantsBetween', () => {
  const times = parseRunTimes('07:00,19:00');

  it('returns run times that fell inside the window, in order', () => {
    const from = new Date('2025-03-29T20:00:00Z');
    const to = new Date('2025-03-30T20:00:00Z');
    expect(scheduledInstantsBetween(from, to, times, LONDON).map((d) => d.toISOString())).toEqual([
      '2025-03-30T06:00:00.000Z',
      '2025-03-30T18:00:00.000Z',
    ]);
  });

  it('excludes the start and includes the end', () => {
    const at = new Date('2026-06-10T06:00:00Z'); // 07:00 BST
    expect(scheduledInstantsBetween(at, at, times, LONDON)).toEqual([]);
    expect(scheduledInstantsBetween(new Date(at.getTime() - 1), at, times, LONDON)).toHaveLength(1);
  });

  it('is empty without run times', () => {
    expect(scheduledInstantsBetween(new Date(0), new Date(), [], LONDON)).toEqual([]);
  });
});

describe('nextScheduledInstant', () => {
  it('finds the next run, rolling over to the next day', () => {
    const times = parseRunTimes('07:00,19:00');
    const after = new Date('2026-06-10T18:30:00Z'); // 19:30 BST
    expect(nextScheduledInstant(after, times, LONDON)?.toISOString()).toBe('2026-06-11T06:00:00.000Z');
  });
});

describe('recentDayKeys', () => {
  it('ends today and counts back the right number of days', () => {
    const keys = recentDayKeys(3, 'UTC', new Date('2026-03-01T12:00:00Z'));
    expect(keys).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });
});
