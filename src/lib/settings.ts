/**
 * Runtime settings, in two scopes.
 *
 * Most settings belong to the install as a whole: the model, the prices, the
 * batch size, the run times. A few describe one particular mailbox — the
 * "About you" profile, the preferences learned from corrections on it, whether
 * that mailbox is still in dry run, and what counts as its backlog. Those are
 * stored against the account and are **never** inherited from a global row, so
 * two mailboxes can never end up sharing a profile.
 *
 * A value that has never been written falls back to the `.env` seed, so a
 * fresh install — and every newly connected mailbox — behaves exactly as the
 * env file says, and the UI takes over from there.
 */

import { z } from 'zod';

import { env } from '@/lib/env';
import { prisma, withDatabase } from '@/lib/prisma';
import { formatRunTimes, parseRunTimes } from '@/lib/time';

export const GLOBAL_SCOPE = 'global';

export interface AppSettings {
  dailyLimit: number;
  /** 0 means "whatever is left of the daily cap". */
  maxPerRun: number;
  aiBatchSize: number;
  maxBodyChars: number;
  runTimes: string;
  newMailPollMinutes: number;
  dryRun: boolean;
  backlogOrder: 'newest' | 'oldest';
  backlogQuery: string;
  labelPrefix: string;
  geminiModel: string;
  priceInputPerM: number;
  priceOutputPerM: number;
  autoTrashMinConfidence: number;
  moveReviewOutOfInbox: boolean;
  starAttention: boolean;
  autoPromoteRules: boolean;
  suggestionThreshold: number;
  learnedNotesAuto: boolean;
  profileText: string;
  learnedNotes: string;
  learnedNotesUpdatedAt: string;
}

interface Codec<T> {
  parse: (raw: string) => T | undefined;
  serialize: (value: T) => string;
  fallback: () => T;
}

function intCodec(fallback: () => number, min: number, max: number): Codec<number> {
  return {
    parse: (raw) => {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
    },
    serialize: (v) => String(Math.round(v)),
    fallback,
  };
}

function floatCodec(fallback: () => number, min: number, max: number): Codec<number> {
  return {
    parse: (raw) => {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
    },
    serialize: (v) => String(v),
    fallback,
  };
}

function boolCodec(fallback: () => boolean): Codec<boolean> {
  return {
    parse: (raw) => (raw === 'true' ? true : raw === 'false' ? false : undefined),
    serialize: (v) => (v ? 'true' : 'false'),
    fallback,
  };
}

function stringCodec(fallback: () => string, max = 10_000): Codec<string> {
  return {
    parse: (raw) => raw.slice(0, max),
    serialize: (v) => v,
    fallback,
  };
}

const CODECS: { [K in keyof AppSettings]: Codec<AppSettings[K]> } = {
  dailyLimit: intCodec(() => env.dailyEmailLimit, 0, 5_000),
  maxPerRun: intCodec(() => 0, 0, 5_000),
  aiBatchSize: intCodec(() => env.aiBatchSize, 1, 50),
  maxBodyChars: intCodec(() => env.maxBodyChars, 200, 20_000),
  runTimes: {
    parse: (raw) => formatRunTimes(parseRunTimes(raw)),
    serialize: (v) => formatRunTimes(parseRunTimes(v)),
    fallback: () => formatRunTimes(parseRunTimes(env.runTimes)),
  },
  newMailPollMinutes: intCodec(() => env.newMailPollMinutes, 0, 1_440),
  dryRun: boolCodec(() => env.dryRun),
  backlogOrder: {
    parse: (raw) => (raw === 'oldest' ? 'oldest' : raw === 'newest' ? 'newest' : undefined),
    serialize: (v) => v,
    fallback: () => env.backlogOrder,
  },
  backlogQuery: stringCodec(() => env.backlogQuery, 500),
  labelPrefix: stringCodec(() => env.labelPrefix, 40),
  geminiModel: stringCodec(() => env.geminiModel, 80),
  priceInputPerM: floatCodec(() => env.geminiPriceInputPerM, 0, 1_000),
  priceOutputPerM: floatCodec(() => env.geminiPriceOutputPerM, 0, 1_000),
  autoTrashMinConfidence: intCodec(() => env.autoTrashMinConfidence, 0, 100),
  moveReviewOutOfInbox: boolCodec(() => true),
  starAttention: boolCodec(() => true),
  autoPromoteRules: boolCodec(() => false),
  suggestionThreshold: intCodec(() => 3, 1, 50),
  learnedNotesAuto: boolCodec(() => true),
  profileText: stringCodec(() => '', 4_000),
  learnedNotes: stringCodec(() => '', 4_000),
  learnedNotesUpdatedAt: stringCodec(() => '', 40),
};

const KEYS = Object.keys(CODECS) as (keyof AppSettings)[];

/**
 * Settings stored against one mailbox rather than the whole install.
 *
 * These deliberately do not fall back to a global row. A profile written for
 * one mailbox must never leak into another, so an unset value here means the
 * `.env` default, not "whatever the other mailbox has".
 */
export const PER_ACCOUNT_KEYS = [
  'profileText',
  'learnedNotes',
  'learnedNotesUpdatedAt',
  'dryRun',
  'backlogOrder',
  'backlogQuery',
] as const;

export type PerAccountKey = (typeof PER_ACCOUNT_KEYS)[number];

const PER_ACCOUNT = new Set<string>(PER_ACCOUNT_KEYS);

export function isPerAccountKey(key: string): key is PerAccountKey {
  return PER_ACCOUNT.has(key);
}

/** Thrown when a per-mailbox setting is written without naming the mailbox. */
export class SettingsScopeError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`"${key}" is a per-mailbox setting; name the mailbox it belongs to.`);
    this.name = 'SettingsScopeError';
    this.key = key;
  }
}

export function defaultSettings(): AppSettings {
  const out = {} as AppSettings;
  for (const key of KEYS) {
    (out as unknown as Record<string, unknown>)[key] = CODECS[key].fallback();
  }
  return out;
}

/**
 * Merge stored rows over the defaults. Pure, so the scoping rule is testable
 * without a database: per-mailbox keys read only from `scoped`, everything
 * else only from `global`.
 */
export function resolveSettings(
  global: Record<string, string>,
  scoped: Record<string, string> | null,
): AppSettings {
  const settings = defaultSettings();
  for (const key of KEYS) {
    const raw = isPerAccountKey(key) ? scoped?.[key] : global[key];
    if (raw === undefined) continue;
    const parsed = (CODECS[key].parse as (raw: string) => unknown)(raw);
    if (parsed !== undefined) (settings as unknown as Record<string, unknown>)[key] = parsed;
  }
  return settings;
}

function splitRows(
  rows: { scope: string; key: string; value: string }[],
): { global: Record<string, string>; byAccount: Map<string, Record<string, string>> } {
  const global: Record<string, string> = {};
  const byAccount = new Map<string, Record<string, string>>();
  for (const row of rows) {
    if (row.scope === GLOBAL_SCOPE) {
      global[row.key] = row.value;
      continue;
    }
    const entry = byAccount.get(row.scope) ?? {};
    entry[row.key] = row.value;
    byAccount.set(row.scope, entry);
  }
  return { global, byAccount };
}

/**
 * Settings as they apply to one mailbox. Called without an account id it
 * returns the global settings, with `.env` defaults for the per-mailbox keys.
 */
export async function getSettings(accountId?: string | null): Promise<AppSettings> {
  const scopes = accountId ? [GLOBAL_SCOPE, accountId] : [GLOBAL_SCOPE];
  const rows = await withDatabase(() =>
    prisma.setting.findMany({ where: { scope: { in: scopes } } }),
  );
  if (!rows.ok) return defaultSettings();
  const { global, byAccount } = splitRows(rows.data);
  return resolveSettings(global, accountId ? (byAccount.get(accountId) ?? {}) : null);
}

/** The same, for several mailboxes at once, in a single query. */
export async function getSettingsForAccounts(
  accountIds: string[],
): Promise<Map<string, AppSettings>> {
  const out = new Map<string, AppSettings>();
  if (accountIds.length === 0) return out;

  const rows = await withDatabase(() =>
    prisma.setting.findMany({ where: { scope: { in: [GLOBAL_SCOPE, ...accountIds] } } }),
  );
  const { global, byAccount } = splitRows(rows.ok ? rows.data : []);
  for (const id of accountIds) {
    out.set(id, resolveSettings(global, byAccount.get(id) ?? {}));
  }
  return out;
}

/**
 * Write a patch. Global keys go to the shared scope; per-mailbox keys need an
 * account id and are rejected without one rather than silently going global.
 */
export async function updateSettings(
  patch: Partial<AppSettings>,
  accountId?: string | null,
): Promise<AppSettings> {
  const writes = [];
  for (const key of KEYS) {
    const value = patch[key];
    if (value === undefined) continue;

    const perAccount = isPerAccountKey(key);
    if (perAccount && !accountId) throw new SettingsScopeError(key);
    const scope = perAccount ? (accountId as string) : GLOBAL_SCOPE;

    const serialized = (CODECS[key].serialize as (value: unknown) => string)(value);
    writes.push(
      prisma.setting.upsert({
        where: { scope_key: { scope, key } },
        create: { scope, key, value: serialized },
        update: { value: serialized },
      }),
    );
  }
  if (writes.length > 0) await prisma.$transaction(writes);
  return getSettings(accountId);
}

/** Called when a mailbox is disconnected so its profile does not linger. */
export async function deleteAccountSettings(accountId: string): Promise<void> {
  await withDatabase(() => prisma.setting.deleteMany({ where: { scope: accountId } }));
}

/** Whether each mailbox is still in dry run, for the dashboard tiles. */
export async function dryRunByAccount(accountIds: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>(accountIds.map((id) => [id, env.dryRun]));
  if (accountIds.length === 0) return out;
  const rows = await withDatabase(() =>
    prisma.setting.findMany({ where: { key: 'dryRun', scope: { in: accountIds } } }),
  );
  if (!rows.ok) return out;
  for (const row of rows.data) out.set(row.scope, row.value === 'true');
  return out;
}

/** Request body contract for PATCH /api/settings. */
export const settingsPatchSchema = z
  .object({
    dailyLimit: z.number().int().min(0).max(5_000),
    maxPerRun: z.number().int().min(0).max(5_000),
    aiBatchSize: z.number().int().min(1).max(50),
    maxBodyChars: z.number().int().min(200).max(20_000),
    runTimes: z.string().max(200),
    newMailPollMinutes: z.number().int().min(0).max(1_440),
    dryRun: z.boolean(),
    backlogOrder: z.enum(['newest', 'oldest']),
    backlogQuery: z.string().max(500),
    labelPrefix: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[^/\\]+$/, 'must not contain slashes'),
    geminiModel: z.string().trim().min(1).max(80),
    priceInputPerM: z.number().min(0).max(1_000),
    priceOutputPerM: z.number().min(0).max(1_000),
    autoTrashMinConfidence: z.number().int().min(0).max(100),
    moveReviewOutOfInbox: z.boolean(),
    starAttention: z.boolean(),
    autoPromoteRules: z.boolean(),
    suggestionThreshold: z.number().int().min(1).max(50),
    learnedNotesAuto: z.boolean(),
    profileText: z.string().max(4_000),
    learnedNotes: z.string().max(4_000),
  })
  .partial()
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
