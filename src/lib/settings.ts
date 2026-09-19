/**
 * Runtime settings.
 *
 * Everything the Settings and Rules pages can change lives in the `settings`
 * table as key/value strings. A value that has never been written falls back
 * to the `.env` seed, so a fresh install behaves exactly as the env file says
 * and the UI takes over from there.
 */

import { z } from 'zod';

import { env } from '@/lib/env';
import { prisma, withDatabase } from '@/lib/prisma';
import { formatRunTimes, parseRunTimes } from '@/lib/time';

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

export function defaultSettings(): AppSettings {
  const out = {} as AppSettings;
  for (const key of KEYS) {
    (out as unknown as Record<string, unknown>)[key] = CODECS[key].fallback();
  }
  return out;
}

/** Current settings: stored values where present, `.env` seeds elsewhere. */
export async function getSettings(): Promise<AppSettings> {
  const settings = defaultSettings();
  const rows = await withDatabase(() => prisma.setting.findMany());
  if (!rows.ok) return settings;

  const byKey = new Map(rows.data.map((row) => [row.key, row.value]));
  for (const key of KEYS) {
    const raw = byKey.get(key);
    if (raw === undefined) continue;
    const parsed = (CODECS[key].parse as (raw: string) => unknown)(raw);
    if (parsed !== undefined) (settings as unknown as Record<string, unknown>)[key] = parsed;
  }
  return settings;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const writes = [];
  for (const key of KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    const serialized = (CODECS[key].serialize as (value: unknown) => string)(value);
    writes.push(
      prisma.setting.upsert({
        where: { key },
        create: { key, value: serialized },
        update: { value: serialized },
      }),
    );
  }
  if (writes.length > 0) await prisma.$transaction(writes);
  return getSettings();
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
