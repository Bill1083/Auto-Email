import { describe, expect, it } from 'vitest';

import { addUsage, computeCostUsd, projectedCost } from '@/lib/pipeline/cost';

describe('computeCostUsd', () => {
  it('bills prompt tokens at the input price and output plus thinking at the output price', () => {
    const cost = computeCostUsd(
      { promptTokens: 5_200, outputTokens: 500, thoughtTokens: 100, cachedTokens: 0 },
      { inputPerM: 0.3, outputPerM: 2.5 },
    );
    // 5200 * 0.3 / 1e6 + 600 * 2.5 / 1e6
    expect(cost).toBeCloseTo(0.00156 + 0.0015, 8);
  });

  it('is zero for zero usage or zero prices', () => {
    expect(computeCostUsd({ promptTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0 }, { inputPerM: 1, outputPerM: 1 })).toBe(0);
    expect(computeCostUsd({ promptTokens: 1000, outputTokens: 10, thoughtTokens: 0, cachedTokens: 0 }, { inputPerM: 0, outputPerM: 0 })).toBe(0);
  });
});

describe('addUsage', () => {
  it('sums every field', () => {
    expect(
      addUsage(
        { promptTokens: 1, outputTokens: 2, thoughtTokens: 3, cachedTokens: 4 },
        { promptTokens: 10, outputTokens: 20, thoughtTokens: 30, cachedTokens: 40 },
      ),
    ).toEqual({ promptTokens: 11, outputTokens: 22, thoughtTokens: 33, cachedTokens: 44 });
  });
});

describe('projectedCost', () => {
  it('uses the observed average when available and a conservative default otherwise', () => {
    expect(projectedCost(10_000, 0.0003)).toBeCloseTo(3, 6);
    expect(projectedCost(10_000, null)).toBeCloseTo(4, 6);
    expect(projectedCost(-5, 0.1)).toBe(0);
  });
});
