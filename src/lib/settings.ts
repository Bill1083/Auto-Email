/**
 * Runtime settings, one set per mailbox.
 *
 * Every setting the dashboard can change belongs to a single mailbox: the
 * "About you" profile, the learned preferences, dry run, the daily cap, the
 * run times, the model and prices, all of it. The mailbox chosen in the
 * top-right switcher is the one being read and edited, and nothing is ever
 * inherited from another mailbox.
 *
 * A value that has never been written falls back to the `.env` seed, so every
 * newly connected mailbox starts exactly as the env file says.
 *
 * The table's "global" scope holds internal state only (the demo mailbox's
 * fixture data), never settings.
 */

import { z } from 'zod';

import { env } from '@/lib/env';
import { prisma, withDatabase } from '@/lib/prisma';
import { formatRunTimes, parseRunTimes } from '@/lib/time';

/** Scope for internal, non-setting rows such as the demo mailbox's state. */
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

/** Thrown when a setting is written without naming the mailbox it belongs to. */
export class SettingsScopeError extends Error {
  constructor() {
    super('Settings belong to a mailbox. Choose one in the top right first.');
    this.name = 'SettingsScopeError';
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
 * Merge one mailbox's stored rows over the defaults. Pure, so it is testable
 * without a database. Unknown keys and values that do not parse are ignored.
 */
export function resolveSettings(stored: Record<string, string>): AppSettings {
  const settings = defaultSettings();
  for (const key of KEYS) {
    const raw = stored[key];
    if (raw === undefined) continue;
    const parsed = (CODECS[key].parse as (raw: string) => unknown)(raw);
    if (parsed !== undefined) (settings as unknown as Record<string, unknown>)[key] = parsed;
  }
  return settings;
}

/**
 * One mailbox's settings. Without a mailbox (the "All accounts" view) there is
 * nothing to read, so the `.env` defaults are returned.
 */
export async function getSettings(accountId?: string | null): Promise<AppSettings> {
  if (!accountId) return defaultSettings();
  const rows = await withDatabase(() => prisma.setting.findMany({ where: { scope: accountId } }));
  if (!rows.ok) return defaultSettings();
  return resolveSettings(Object.fromEntries(rows.data.map((row) => [row.key, row.value])));
}

/** Several mailboxes' settings in a single query. */
export async function getSettingsForAccounts(
  accountIds: string[],
): Promise<Map<string, AppSettings>> {
  const out = new Map<string, AppSettings>();
  if (accountIds.length === 0) return out;

  const rows = await withDatabase(() =>
    prisma.setting.findMany({ where: { scope: { in: accountIds } } }),
  );
  const byAccount = new Map<string, Record<string, string>>();
  for (const row of rows.ok ? rows.data : []) {
    const entry = byAccount.get(row.scope) ?? {};
    entry[row.key] = row.value;
    byAccount.set(row.scope, entry);
  }
  for (const id of accountIds) out.set(id, resolveSettings(byAccount.get(id) ?? {}));
  return out;
}

/** Write a patch to one mailbox. Refused without a mailbox, never written globally. */
export async function updateSettings(
  patch: Partial<AppSettings>,
  accountId: string | null | undefined,
): Promise<AppSettings> {
  if (!accountId) throw new SettingsScopeError();

  const writes = [];
  for (const key of KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    const serialized = (CODECS[key].serialize as (value: unknown) => string)(value);
    writes.push(
      prisma.setting.upsert({
        where: { scope_key: { scope: accountId, key } },
        create: { scope: accountId, key, value: serialized },
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

/** Whether each mailbox is still in dry run. */
export async function dryRunByAccount(accountIds: string[]): Promise<Map<string, boolean>> {
  const settings = await getSettingsForAccounts(accountIds);
  return new Map(accountIds.map((id) => [id, settings.get(id)?.dryRun ?? env.dryRun]));
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
