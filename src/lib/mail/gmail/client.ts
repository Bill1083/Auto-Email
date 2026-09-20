/**
 * Thin typed wrapper over the Gmail REST API.
 *
 * Seven endpoints are all the pipeline needs. Access tokens come from a
 * supplier so this class knows nothing about storage or encryption; a 401
 * triggers one refresh-and-retry, and rate limits / 5xx are retried with
 * backoff.
 */

import {
  ProviderError,
  ReauthRequiredError,
  type ListPage,
  type MailProfile,
  type MailProvider,
} from '@/lib/mail/provider';
import { bodyTextOf, cleanBody, parseGmailMessage, type GmailMessage } from '@/lib/mail/gmail/parse';
import type { RawEmail } from '@/lib/types';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Quota windows are per minute, so the last few waits need to be long enough
// to cross one: 1s, 2s, 4s, 8s, 16s, 32s.
const MAX_ATTEMPTS = 6;

export interface TokenSupplier {
  /** A valid access token; `forceRefresh` after a 401. */
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gmail reports rate and quota limits as 403, not 429, so a 403 has to be read
 * before deciding whether it is permanent. These are the retryable ones.
 */
const QUOTA_ERROR =
  /rateLimitExceeded|userRateLimitExceeded|quota ?exceeded|too many concurrent|backendError|Resource has been exhausted/i;

export function isRetryableQuotaError(detail: string): boolean {
  return QUOTA_ERROR.test(detail);
}

/**
 * Smooths bursts across every request this process makes. A run with a large
 * daily cap fetches hundreds of messages back to back, which is exactly what
 * trips Gmail's per-minute quota; spacing them costs a few seconds and keeps
 * the run well inside it.
 */
const MIN_REQUEST_GAP_MS = 60;
let nextSlot = 0;

/**
 * Google's documented remedy for a quota error: exponential backoff with
 * jitter, honouring Retry-After when it is sent.
 */
export function backoffMs(attempt: number, retryAfter?: string | null): number {
  const seconds = Number(retryAfter ?? '');
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(60_000, seconds * 1000);
  const base = Math.min(32_000, 1_000 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 500);
}

async function takeSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_REQUEST_GAP_MS;
  if (at > now) await sleep(at - now);
}

export class GmailClient implements MailProvider {
  readonly kind = 'gmail' as const;

  constructor(private readonly tokens: TokenSupplier) {}

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T | null> {
    const url = new URL(`${BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    let refreshed = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await takeSlot();
      const token = await this.tokens.getAccessToken(refreshed && attempt > 1 ? false : undefined);
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          throw new ProviderError(
            `Gmail request failed: ${error instanceof Error ? error.message : 'network error'}`,
            502,
          );
        }
        await sleep(500 * attempt);
        continue;
      }

      if (response.status === 404) return null;
      if (response.status === 204) return {} as T;

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.tokens.getAccessToken(true);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        const detail = await safeErrorText(response);
        if (response.status === 401 || /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED/i.test(detail)) {
          throw new ReauthRequiredError(`Gmail rejected the connection (${response.status}): ${detail}`);
        }
        // Gmail answers a quota or rate limit with 403 rather than 429, so a
        // 403 is only permanent once its message says something else.
        if (!isRetryableQuotaError(detail)) {
          throw new ProviderError(`Gmail refused the request (403): ${detail}`, 403);
        }
        if (attempt === MAX_ATTEMPTS) {
          throw new ProviderError(
            `Gmail is still rate limiting after ${MAX_ATTEMPTS} attempts: ${detail}`,
            429,
          );
        }
        await sleep(backoffMs(attempt, response.headers.get('retry-after')));
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt === MAX_ATTEMPTS) {
          throw new ProviderError(
            `Gmail is rate limiting or unavailable (${response.status}).`,
            response.status,
          );
        }
        await sleep(backoffMs(attempt, response.headers.get('retry-after')));
        continue;
      }

      if (!response.ok) {
        throw new ProviderError(
          `Gmail request failed (${response.status}): ${await safeErrorText(response)}`,
          response.status,
        );
      }

      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    throw new ProviderError('Gmail request failed after retries.', 502);
  }

  // -------------------------------------------------------------------------
  // MailProvider
  // -------------------------------------------------------------------------

  async profile(): Promise<MailProfile> {
    const data = await this.request<{ emailAddress: string; messagesTotal?: number }>(
      'GET',
      '/profile',
    );
    if (!data) throw new ProviderError('Gmail profile not found.', 404);
    return { email: data.emailAddress.toLowerCase(), messagesTotal: data.messagesTotal ?? 0 };
  }

  async listIds(query: string, limit: number, pageToken?: string | null): Promise<ListPage> {
    const data = await this.request<{
      messages?: { id: string; threadId: string }[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>('GET', '/messages', {
      query: {
        q: query,
        maxResults: Math.min(500, Math.max(1, limit)),
        pageToken: pageToken ?? undefined,
        includeSpamTrash: 'false',
      },
    });
    return {
      ids: (data?.messages ?? []).map((m) => m.id),
      nextPageToken: data?.nextPageToken ?? null,
      estimate: data?.resultSizeEstimate ?? 0,
    };
  }

  async fetch(id: string, maxBodyChars: number): Promise<RawEmail | null> {
    const data = await this.request<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}`, {
      query: { format: 'full' },
    });
    return data ? parseGmailMessage(data, maxBodyChars) : null;
  }

  async fetchBody(id: string, maxChars: number): Promise<string | null> {
    const data = await this.request<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}`, {
      query: { format: 'full' },
    });
    if (!data) return null;
    return cleanBody(bodyTextOf(data.payload).text, maxChars);
  }

  async modify(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    if (ids.length === 0 || (addLabelIds.length === 0 && removeLabelIds.length === 0)) return;
    // batchModify accepts up to 1000 ids per call.
    for (let i = 0; i < ids.length; i += 1000) {
      await this.request('POST', '/messages/batchModify', {
        body: { ids: ids.slice(i, i + 1000), addLabelIds, removeLabelIds },
      });
    }
  }

  async trash(id: string): Promise<void> {
    await this.request('POST', `/messages/${encodeURIComponent(id)}/trash`);
  }

  async untrash(id: string): Promise<void> {
    await this.request('POST', `/messages/${encodeURIComponent(id)}/untrash`);
  }

  async ensureLabels(names: string[]): Promise<Record<string, string>> {
    const existing = await this.listLabels();
    const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label.id]));
    const result: Record<string, string> = {};

    // Parents first so nested names like AutoMail/Finance always have AutoMail.
    const ordered = [...new Set(names)].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const name of ordered) {
      const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : null;
      if (parent && !byName.has(parent.toLowerCase())) {
        const created = await this.createLabel(parent);
        byName.set(parent.toLowerCase(), created);
      }
      let id = byName.get(name.toLowerCase());
      if (!id) {
        id = await this.createLabel(name);
        byName.set(name.toLowerCase(), id);
      }
      result[name] = id;
    }
    return result;
  }

  private async listLabels(): Promise<GmailLabel[]> {
    const data = await this.request<{ labels?: GmailLabel[] }>('GET', '/labels');
    return data?.labels ?? [];
  }

  private async createLabel(name: string): Promise<string> {
    try {
      const created = await this.request<GmailLabel>('POST', '/labels', {
        body: {
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      });
      if (created?.id) return created.id;
    } catch (error) {
      // 409: created concurrently or a case-insensitive match exists.
      if (!(error instanceof ProviderError && error.status === 409)) throw error;
    }
    const again = (await this.listLabels()).find(
      (label) => label.name.toLowerCase() === name.toLowerCase(),
    );
    if (!again) throw new ProviderError(`Could not create the Gmail label "${name}".`, 502);
    return again.id;
  }
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { error?: { message?: string; status?: string } };
    return json.error?.message ?? json.error?.status ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
