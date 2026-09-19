/**
 * Connected accounts: lookup, the selected-account cookie, and the provider
 * factory that turns an Account row into something the pipeline can call.
 */

import type { Account } from '@prisma/client';
import { cookies } from 'next/headers';

import { decryptSecret, encryptSecret, isEncryptionConfigured } from '@/lib/crypto';
import { env } from '@/lib/env';
import { categoryLabelName, listCategories } from '@/lib/categories';
import { GmailClient, type TokenSupplier } from '@/lib/mail/gmail/client';
import { refreshAccessToken } from '@/lib/mail/gmail/oauth';
import { MockProvider } from '@/lib/mail/mock';
import { ReauthRequiredError, type MailProvider } from '@/lib/mail/provider';
import { prisma, withDatabase } from '@/lib/prisma';
import { getSettings } from '@/lib/settings';
import { SYSTEM_LABELS, parseLabelMap, type LabelMap } from '@/lib/types';

export const ACCOUNT_COOKIE = 'automail_account';
export const ALL_ACCOUNTS = 'all';

export type AccountSummary = Pick<
  Account,
  | 'id'
  | 'email'
  | 'displayName'
  | 'provider'
  | 'status'
  | 'lastError'
  | 'lastSyncAt'
  | 'lastNewLaneAt'
  | 'backlogDone'
  | 'backlogEstimate'
  | 'backlogBuiltAt'
  | 'dailyLimit'
  | 'createdAt'
>;

export async function listAccounts(): Promise<Account[]> {
  const result = await withDatabase(() =>
    prisma.account.findMany({ orderBy: { createdAt: 'asc' } }),
  );
  return result.ok ? result.data : [];
}

export async function getAccount(id: string): Promise<Account | null> {
  const result = await withDatabase(() => prisma.account.findUnique({ where: { id } }));
  return result.ok ? result.data : null;
}

/** Strip secrets before anything leaves the server. */
export function toSummary(account: Account): AccountSummary {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    provider: account.provider,
    status: account.status,
    lastError: account.lastError,
    lastSyncAt: account.lastSyncAt,
    lastNewLaneAt: account.lastNewLaneAt,
    backlogDone: account.backlogDone,
    backlogEstimate: account.backlogEstimate,
    backlogBuiltAt: account.backlogBuiltAt,
    dailyLimit: account.dailyLimit,
    createdAt: account.createdAt,
  };
}

/**
 * The account the dashboard is currently showing. `null` means "all
 * accounts". Falls back to the first account when the cookie points at one
 * that no longer exists.
 */
export async function resolveSelection(
  accounts?: Account[],
): Promise<{ accounts: Account[]; selected: Account | null; selectedId: string }> {
  const list = accounts ?? (await listAccounts());
  const raw = cookies().get(ACCOUNT_COOKIE)?.value;
  if (!raw || raw === ALL_ACCOUNTS) {
    // A single account never needs the aggregate view.
    if (list.length === 1 && !raw) return { accounts: list, selected: list[0], selectedId: list[0].id };
    return { accounts: list, selected: null, selectedId: ALL_ACCOUNTS };
  }
  const match = list.find((account) => account.id === raw);
  if (match) return { accounts: list, selected: match, selectedId: match.id };
  return list.length > 0
    ? { accounts: list, selected: list[0], selectedId: list[0].id }
    : { accounts: list, selected: null, selectedId: ALL_ACCOUNTS };
}

export async function markNeedsReauth(accountId: string, reason: string): Promise<void> {
  await withDatabase(() =>
    prisma.account.update({
      where: { id: accountId },
      data: { status: 'NEEDS_REAUTH', lastError: reason.slice(0, 500) },
    }),
  );
}

export async function recordAccountError(accountId: string, reason: string | null): Promise<void> {
  await withDatabase(() =>
    prisma.account.update({
      where: { id: accountId },
      data: { lastError: reason ? reason.slice(0, 500) : null },
    }),
  );
}

function gmailTokenSupplier(account: Account): TokenSupplier {
  let cachedToken: string | null = null;
  let cachedExpiry = 0;
  let primed = false;

  async function prime(): Promise<void> {
    if (primed) return;
    primed = true;
    if (account.accessTokenEnc && account.accessTokenExpiresAt) {
      try {
        cachedToken = await decryptSecret(account.accessTokenEnc);
        cachedExpiry = account.accessTokenExpiresAt.getTime();
      } catch {
        cachedToken = null;
      }
    }
  }

  return {
    async getAccessToken(forceRefresh?: boolean): Promise<string> {
      await prime();
      const fresh = cachedToken && cachedExpiry - Date.now() > 60_000;
      if (fresh && !forceRefresh) return cachedToken as string;

      if (!account.refreshTokenEnc) {
        await markNeedsReauth(account.id, 'No refresh token is stored for this account.');
        throw new ReauthRequiredError();
      }
      let refreshToken: string;
      try {
        refreshToken = await decryptSecret(account.refreshTokenEnc);
      } catch {
        await markNeedsReauth(
          account.id,
          'The stored token could not be decrypted. TOKEN_ENCRYPTION_KEY has probably changed.',
        );
        throw new ReauthRequiredError();
      }

      try {
        const tokens = await refreshAccessToken(refreshToken);
        cachedToken = tokens.accessToken;
        cachedExpiry = tokens.expiresAt.getTime();
        const accessTokenEnc = await encryptSecret(tokens.accessToken);
        const rotatedRefresh =
          tokens.refreshToken && tokens.refreshToken !== refreshToken
            ? await encryptSecret(tokens.refreshToken)
            : null;
        await withDatabase(() =>
          prisma.account.update({
            where: { id: account.id },
            data: {
              accessTokenEnc,
              accessTokenExpiresAt: tokens.expiresAt,
              ...(rotatedRefresh ? { refreshTokenEnc: rotatedRefresh } : {}),
              status: 'ACTIVE',
              lastError: null,
            },
          }),
        );
        return cachedToken;
      } catch (error) {
        if (error instanceof ReauthRequiredError) {
          await markNeedsReauth(account.id, error.message);
        }
        throw error;
      }
    },
  };
}

export function providerFor(account: Account): MailProvider {
  if (account.provider === 'mock') return new MockProvider(account.email);
  if (!isEncryptionConfigured()) {
    throw new ReauthRequiredError('TOKEN_ENCRYPTION_KEY is not configured; stored tokens cannot be read.');
  }
  return new GmailClient(gmailTokenSupplier(account));
}

/**
 * Make sure every category label and both system labels exist on the
 * provider, and return the map the pipeline applies changes with. Cached in
 * `labelMapJson`; recomputed when a category or the prefix changed.
 */
export async function ensureAccountLabels(
  account: Account,
  provider: MailProvider,
  options: { force?: boolean } = {},
): Promise<LabelMap> {
  // The prefix is a per-mailbox setting. The account column only records the
  // prefix the cached label ids were created under.
  const settings = await getSettings(account.id);
  const prefix = settings.labelPrefix || env.labelPrefix;
  const categories = await listCategories(true);

  const wanted: { key: string; name: string }[] = [
    { key: SYSTEM_LABELS.review, name: categoryLabelName(prefix, 'Review') },
    { key: SYSTEM_LABELS.attention, name: categoryLabelName(prefix, 'Attention') },
  ];
  for (const category of categories) {
    if (category.labelName) {
      wanted.push({ key: category.key, name: categoryLabelName(prefix, category.labelName) });
    }
  }

  // A changed prefix means different label names, so the cached ids are stale.
  const existing = account.labelPrefix === prefix ? parseLabelMap(account.labelMapJson) : {};
  const missing = wanted.filter((w) => !existing[w.key]);
  if (!options.force && missing.length === 0) return existing;

  const created = await provider.ensureLabels(wanted.map((w) => w.name));
  const map: LabelMap = { ...existing };
  for (const w of wanted) {
    if (created[w.name]) map[w.key] = created[w.name];
  }
  await withDatabase(() =>
    prisma.account.update({
      where: { id: account.id },
      data: { labelMapJson: JSON.stringify(map), labelPrefix: prefix },
    }),
  );
  return map;
}
