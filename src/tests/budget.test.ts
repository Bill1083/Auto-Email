import { describe, expect, it, vi } from 'vitest';

// No database in these tests: only the pure arithmetic is exercised.
vi.mock('@/lib/prisma', () => ({
  prisma: {},
  withDatabase: async () => ({ ok: false, error: 'mocked' }),
  isDatabaseReachable: async () => false,
}));

import { computeBudget, daysToClear, effectiveDailyLimit } from '@/lib/pipeline/budget';

describe('computeBudget', () => {
  it('is what is left of the daily cap', () => {
    expect(computeBudget({ dailyLimit: 100, processedToday: 40, maxPerRun: 0 })).toBe(60);
  });

  it('never goes negative once the cap is exceeded', () => {
    expect(computeBudget({ dailyLimit: 100, processedToday: 140, maxPerRun: 0 })).toBe(0);
  });

  it('is further capped by the per-run ceiling when set', () => {
    expect(computeBudget({ dailyLimit: 100, processedToday: 0, maxPerRun: 25 })).toBe(25);
    expect(computeBudget({ dailyLimit: 100, processedToday: 90, maxPerRun: 25 })).toBe(10);
  });

  it('treats a zero cap as processing nothing', () => {
    expect(computeBudget({ dailyLimit: 0, processedToday: 0, maxPerRun: 0 })).toBe(0);
  });
});

describe('effectiveDailyLimit', () => {
  it('uses the account override when present', () => {
    expect(effectiveDailyLimit({ dailyLimit: 20 }, { dailyLimit: 100 })).toBe(20);
    expect(effectiveDailyLimit({ dailyLimit: null }, { dailyLimit: 100 })).toBe(100);
  });
});

describe('daysToClear', () => {
  it('rounds up to whole days', () => {
    expect(daysToClear(10_000, 100)).toBe(100);
    expect(daysToClear(101, 100)).toBe(2);
  });

  it('handles the edge cases', () => {
    expect(daysToClear(0, 100)).toBe(0);
    expect(daysToClear(50, 0)).toBeNull();
  });
});
