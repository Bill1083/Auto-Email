/**
 * Making sense of Gemini's failures.
 *
 * Kept free of the SDK and of server-only imports so the dashboard can use
 * the same wording when it shows an old failure, and so every rule here is
 * unit-tested directly.
 *
 * The distinction that matters is "try again later" (the model is overloaded,
 * or this key is being rate limited) versus "this request is wrong". The
 * first is retried, and if it still fails the emails are left untouched for a
 * later run; the second is surfaced to the user.
 */

export type GeminiErrorKind = 'OVERLOADED' | 'RATE_LIMITED' | 'API_ERROR';

export interface ParsedGeminiError {
  /** HTTP status, e.g. 503. */
  httpStatus: number | null;
  /** Google's status name, e.g. UNAVAILABLE. */
  status: string | null;
  /** The human sentence inside the error, without the JSON around it. */
  message: string;
  /** How long Google asked us to wait, when it said. */
  retryAfterSeconds: number | null;
}

interface GoogleErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    details?: { '@type'?: unknown; retryDelay?: unknown }[];
  };
}

function parseSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Pull the useful parts out of whatever the SDK threw. It is usually a JSON
 * body, sometimes prefixed with "got status: 503 Service Unavailable.", and
 * occasionally plain text.
 */
export function parseGeminiError(raw: string, httpStatus?: number | null): ParsedGeminiError {
  const text = raw ?? '';
  let status: string | null = null;
  let message = text.trim();
  let code: number | null = typeof httpStatus === 'number' ? httpStatus : null;
  let retryAfterSeconds: number | null = null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const body = JSON.parse(text.slice(start, end + 1)) as GoogleErrorBody;
      const error = body.error;
      if (error) {
        if (typeof error.code === 'number') code = code ?? error.code;
        if (typeof error.status === 'string') status = error.status;
        if (typeof error.message === 'string' && error.message.trim()) message = error.message.trim();
        for (const detail of error.details ?? []) {
          const seconds = parseSeconds(detail?.retryDelay);
          if (seconds !== null) retryAfterSeconds = seconds;
        }
      }
    } catch {
      // Not JSON after all; fall through to the text patterns.
    }
  }

  if (code === null) {
    const fromText = /(?:got status:|status code|"code":)\s*(\d{3})/i.exec(text);
    if (fromText) code = Number(fromText[1]);
  }
  if (retryAfterSeconds === null) {
    const fromText = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(text);
    if (fromText) retryAfterSeconds = Number(fromText[1]);
  }

  return { httpStatus: code, status, message: message || 'Unknown error', retryAfterSeconds };
}

const OVERLOADED_HTTP = new Set([500, 502, 503, 504]);
const OVERLOADED_STATUS = new Set(['UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED']);
const OVERLOADED_TEXT = /overloaded|high demand|try again later|temporarily unavailable/i;
const RATE_LIMITED_TEXT = /rate limit|exceeded your current quota|too many requests/i;

/** Is this "try again later", and if so, which kind? */
export function classifyGeminiError(error: ParsedGeminiError): GeminiErrorKind {
  if (
    error.httpStatus === 429 ||
    error.status === 'RESOURCE_EXHAUSTED' ||
    RATE_LIMITED_TEXT.test(error.message)
  ) {
    return 'RATE_LIMITED';
  }
  if (
    (error.httpStatus !== null && OVERLOADED_HTTP.has(error.httpStatus)) ||
    (error.status !== null && OVERLOADED_STATUS.has(error.status)) ||
    OVERLOADED_TEXT.test(error.message)
  ) {
    return 'OVERLOADED';
  }
  return 'API_ERROR';
}

/** Total tries for one request, including the first. */
export const GEMINI_MAX_ATTEMPTS = 4;

/** Longer than this and it is not worth holding a run open for. */
const MAX_HONOURED_WAIT_SECONDS = 60;

const BACKOFF_MS = [2_000, 6_000, 15_000];

/**
 * How long to wait after failed attempt `attempt` (1-based) before trying
 * again, or null to stop. A wait Google asked for is honoured when it is
 * short; a long one means a quota that will not reset inside this run.
 */
export function geminiRetryDelayMs(
  attempt: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random,
): number | null {
  if (attempt >= GEMINI_MAX_ATTEMPTS) return null;
  if (retryAfterSeconds !== null) {
    if (retryAfterSeconds > MAX_HONOURED_WAIT_SECONDS) return null;
    return Math.ceil(retryAfterSeconds * 1000) + Math.floor(random() * 500);
  }
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1];
  return base + Math.floor(random() * 1_000);
}

/** One readable sentence, e.g. "Gemini is overloaded (503): This model is…". */
export function describeGeminiError(error: ParsedGeminiError, kind = classifyGeminiError(error)): string {
  const label =
    kind === 'OVERLOADED'
      ? 'Gemini is overloaded right now'
      : kind === 'RATE_LIMITED'
        ? 'Gemini rate limit reached'
        : 'Gemini rejected the request';
  const code = error.httpStatus ?? error.status;
  const message = error.message.length > 240 ? `${error.message.slice(0, 240)}…` : error.message;
  return `${label}${code ? ` (${code})` : ''}: ${message}`;
}

/**
 * Tidy a stored reason for display. Older failures were saved with Google's
 * raw JSON in them; this turns that back into the sentence inside it.
 */
export function friendlyReason(reason: string): string {
  const start = reason.indexOf('{"error"');
  if (start === -1) return reason;
  const parsed = parseGeminiError(reason.slice(start));
  const prefix = reason.slice(0, start).trim();
  return `${prefix ? `${prefix} ` : ''}${describeGeminiError(parsed)}`;
}
