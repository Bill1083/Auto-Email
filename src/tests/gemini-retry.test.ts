import { describe, expect, it } from 'vitest';

import {
  GEMINI_MAX_ATTEMPTS,
  classifyGeminiError,
  describeGeminiError,
  friendlyReason,
  geminiRetryDelayMs,
  parseGeminiError,
} from '@/lib/gemini-errors';
import { retryDelayMinutes } from '@/lib/pipeline/retry-queue';

// The exact body Gemini returned when it was overloaded.
const OVERLOADED =
  '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}';

const RATE_LIMITED = JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }],
  },
});

describe('parseGeminiError', () => {
  it('reads the status, sentence and suggested wait out of the JSON body', () => {
    expect(parseGeminiError(OVERLOADED)).toEqual({
      httpStatus: 503,
      status: 'UNAVAILABLE',
      message:
        'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
      retryAfterSeconds: null,
    });
    expect(parseGeminiError(RATE_LIMITED).retryAfterSeconds).toBe(37);
  });

  it('copes with the SDK prefixing the body, and with plain text', () => {
    const prefixed = parseGeminiError(`got status: 503 Service Unavailable. ${OVERLOADED}`);
    expect(prefixed.httpStatus).toBe(503);
    expect(prefixed.status).toBe('UNAVAILABLE');

    const plain = parseGeminiError('got status: 502 Bad Gateway. upstream reset');
    expect(plain.httpStatus).toBe(502);
    expect(plain.message).toBe('got status: 502 Bad Gateway. upstream reset');
  });

  it('prefers the status the SDK reported over the one in the text', () => {
    expect(parseGeminiError(OVERLOADED, 500).httpStatus).toBe(500);
  });
});

describe('classifyGeminiError', () => {
  it('treats a busy model and a rate limit as worth retrying', () => {
    expect(classifyGeminiError(parseGeminiError(OVERLOADED))).toBe('OVERLOADED');
    expect(classifyGeminiError(parseGeminiError(RATE_LIMITED))).toBe('RATE_LIMITED');
    expect(classifyGeminiError(parseGeminiError('The model is overloaded.'))).toBe('OVERLOADED');
    expect(classifyGeminiError(parseGeminiError('', 504))).toBe('OVERLOADED');
  });

  it('leaves a request that is simply wrong alone', () => {
    const badKey = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}';
    expect(classifyGeminiError(parseGeminiError(badKey))).toBe('API_ERROR');
    const denied = '{"error":{"code":403,"message":"Permission denied on the internal resource.","status":"PERMISSION_DENIED"}}';
    expect(classifyGeminiError(parseGeminiError(denied))).toBe('API_ERROR');
  });
});

describe('geminiRetryDelayMs', () => {
  const noJitter = () => 0;

  it('backs off and then gives up', () => {
    expect(geminiRetryDelayMs(1, null, noJitter)).toBe(2_000);
    expect(geminiRetryDelayMs(2, null, noJitter)).toBe(6_000);
    expect(geminiRetryDelayMs(3, null, noJitter)).toBe(15_000);
    expect(geminiRetryDelayMs(GEMINI_MAX_ATTEMPTS, null, noJitter)).toBeNull();
  });

  it('honours a short wait Google asks for, but not one that outlasts the run', () => {
    expect(geminiRetryDelayMs(1, 37, noJitter)).toBe(37_000);
    expect(geminiRetryDelayMs(1, 3_600, noJitter)).toBeNull();
  });

  it('adds jitter so parallel callers do not retry in lockstep', () => {
    expect(geminiRetryDelayMs(1, null, () => 0.999)).toBeGreaterThan(2_900);
  });
});

describe('describeGeminiError and friendlyReason', () => {
  it('turns the raw JSON into one readable sentence', () => {
    expect(describeGeminiError(parseGeminiError(OVERLOADED))).toBe(
      'Gemini is overloaded right now (503): This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
    );
  });

  it('tidies reasons stored before this was handled', () => {
    expect(friendlyReason(`Not classified: The Gemini request failed. ${OVERLOADED}`)).toBe(
      'Not classified: The Gemini request failed. Gemini is overloaded right now (503): This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
    );
    expect(friendlyReason('Promotional email from a retailer.')).toBe('Promotional email from a retailer.');
  });
});

describe('retryDelayMinutes', () => {
  it('waits longer each time Gemini is still busy, up to an hour', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMinutes)).toEqual([10, 20, 40, 60, 60, 60]);
  });
});
