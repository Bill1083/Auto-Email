import { describe, expect, it } from 'vitest';

import { backoffMs, isRetryableQuotaError } from '@/lib/mail/gmail/client';

describe('isRetryableQuotaError', () => {
  it('treats Gmail quota and rate limits as retryable', () => {
    // Gmail answers a quota problem with 403, not 429. This is the real
    // message a large daily cap produced.
    expect(
      isRetryableQuotaError(
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:1234'.",
      ),
    ).toBe(true);
    expect(isRetryableQuotaError('rateLimitExceeded')).toBe(true);
    expect(isRetryableQuotaError('User-rate limit exceeded: userRateLimitExceeded')).toBe(true);
    expect(isRetryableQuotaError('Too many concurrent requests for user')).toBe(true);
    expect(isRetryableQuotaError('backendError')).toBe(true);
  });

  it('leaves genuinely permanent refusals alone', () => {
    expect(isRetryableQuotaError('Request had insufficient authentication scopes.')).toBe(false);
    expect(isRetryableQuotaError('Gmail API has not been used in project 1234 before or it is disabled.')).toBe(false);
    expect(isRetryableQuotaError('Mail service not enabled')).toBe(false);
    expect(isRetryableQuotaError('')).toBe(false);
  });
});

describe('backoffMs', () => {
  it('honours Retry-After when the server sends one', () => {
    expect(backoffMs(1, '20')).toBe(20_000);
    expect(backoffMs(3, '5')).toBe(5_000);
  });

  it('caps a hostile Retry-After so a run cannot stall for minutes', () => {
    expect(backoffMs(1, '600')).toBe(60_000);
  });

  it('doubles each attempt with jitter, and crosses a one-minute window', () => {
    const waits = [1, 2, 3, 4, 5, 6].map((attempt) => backoffMs(attempt));
    expect(waits[0]).toBeGreaterThanOrEqual(1_000);
    expect(waits[0]).toBeLessThan(1_500);
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]).toBeGreaterThan(waits[i - 1]);
    }
    // Attempts 1-6 total more than 60s, so a per-minute quota window passes.
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(60_000);
    expect(waits[waits.length - 1]).toBeLessThanOrEqual(32_500);
  });

  it('ignores a nonsense Retry-After and falls back to the curve', () => {
    expect(backoffMs(1, 'soon')).toBeGreaterThanOrEqual(1_000);
    expect(backoffMs(1, '-5')).toBeGreaterThanOrEqual(1_000);
    expect(backoffMs(2, null)).toBeGreaterThanOrEqual(2_000);
  });
});
