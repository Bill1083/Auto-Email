/**
 * The mailbox abstraction the pipeline talks to.
 *
 * Gmail is the only real implementation today; the mock provider serves a
 * fixture mailbox so the whole app can be exercised without credentials, and
 * the interface is small enough that an IMAP or Outlook provider could be
 * added behind it later.
 */

import type { RawEmail } from '@/lib/types';

export interface MailProfile {
  email: string;
  messagesTotal: number;
}

export interface ListPage {
  ids: string[];
  nextPageToken: string | null;
  /** Provider's estimate of the total match count for the query. */
  estimate: number;
}

export interface MailProvider {
  readonly kind: 'gmail' | 'mock';
  profile(): Promise<MailProfile>;
  /**
   * Ids matching a Gmail-style search query, newest first. `after:`/`before:`
   * accept epoch seconds. `limit` is per page.
   */
  listIds(query: string, limit: number, pageToken?: string | null): Promise<ListPage>;
  /** Parsed headers, signals and a body excerpt. Null when the message is gone. */
  fetch(id: string, maxBodyChars: number): Promise<RawEmail | null>;
  /** A longer body excerpt for the preview pane. */
  fetchBody(id: string, maxChars: number): Promise<string | null>;
  modify(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void>;
  trash(id: string): Promise<void>;
  untrash(id: string): Promise<void>;
  /** Create any label that does not exist yet; returns name -> id for all. */
  ensureLabels(names: string[]): Promise<Record<string, string>>;
}

/** Thrown when the provider's credentials no longer work and a user must reconnect. */
export class ReauthRequiredError extends Error {
  constructor(message = 'The mailbox connection has expired; reconnect the account.') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

/** Thrown for provider failures that are worth surfacing as-is. */
export class ProviderError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
