/**
 * Cost arithmetic.
 *
 * Gemini reports token counts on every response; multiplied by the per-million
 * prices from Settings that gives an exact figure per call. Cached prompt
 * tokens are billed at a discount by Google, which is ignored here, so the
 * number shown is a slight overestimate rather than an underestimate.
 */

import type { TokenUsage } from '@/lib/types';

export interface Prices {
  inputPerM: number;
  outputPerM: number;
}

export function computeCostUsd(usage: TokenUsage, prices: Prices): number {
  const input = Math.max(0, usage.promptTokens);
  const output = Math.max(0, usage.outputTokens) + Math.max(0, usage.thoughtTokens);
  const cost = (input * prices.inputPerM + output * prices.outputPerM) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thoughtTokens: a.thoughtTokens + b.thoughtTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}

/**
 * A planning estimate for emails not yet processed, from the observed average
 * cost per AI-classified email. Falls back to a conservative constant when
 * nothing has been classified yet.
 */
export function projectedCost(
  emails: number,
  observedAvgPerEmail: number | null,
  fallbackPerEmail = 0.0004,
): number {
  const perEmail = observedAvgPerEmail && observedAvgPerEmail > 0 ? observedAvgPerEmail : fallbackPerEmail;
  return Math.max(0, emails) * perEmail;
}
