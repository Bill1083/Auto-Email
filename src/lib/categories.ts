/**
 * The category taxonomy.
 *
 * A closed list the model must choose from. Free-form labels drift and
 * multiply; a fixed set with descriptions keeps the labels in Gmail tidy and
 * lets the user adjust behaviour per category (default action, whether the
 * AI may ever trash it, auto-trash once trusted).
 */

import type { Category } from '@prisma/client';

import { prisma, withDatabase } from '@/lib/prisma';
import type { Action } from '@/lib/types';

export interface CategoryDef {
  key: string;
  name: string;
  description: string;
  /** Label name below the prefix, or null for "no label" (Junk). */
  labelName: string | null;
  defaultAction: Action;
  allowTrash: boolean;
  sortOrder: number;
}

export const OTHER_CATEGORY = 'OTHER';

export const BUILT_IN_CATEGORIES: CategoryDef[] = [
  {
    key: 'PERSONAL',
    name: 'Personal',
    description:
      'Mail written by a person to you: friends, family, acquaintances, personal correspondence and replies in a real conversation.',
    labelName: 'Personal',
    defaultAction: 'KEEP',
    allowTrash: false,
    sortOrder: 10,
  },
  {
    key: 'WORK',
    name: 'Work',
    description:
      'Clients, colleagues, contracts, proposals, quotes and professional correspondence written by a person or on behalf of one.',
    labelName: 'Work',
    defaultAction: 'KEEP',
    allowTrash: false,
    sortOrder: 20,
  },
  {
    key: 'FINANCE',
    name: 'Finance',
    description:
      'Banks, brokers, prop firms, invoices to pay or that were issued, tax, insurance, payroll, statements, anything about money owed or owned.',
    labelName: 'Finance',
    defaultAction: 'KEEP',
    allowTrash: false,
    sortOrder: 30,
  },
  {
    key: 'RECEIPTS',
    name: 'Receipts',
    description:
      'Order confirmations, payment receipts, shipping updates and booking confirmations that need no action but may be worth finding later.',
    labelName: 'Receipts',
    defaultAction: 'ARCHIVE',
    allowTrash: false,
    sortOrder: 40,
  },
  {
    key: 'TRAVEL',
    name: 'Travel',
    description: 'Itineraries, tickets, boarding passes, check-in reminders, accommodation details.',
    labelName: 'Travel',
    defaultAction: 'KEEP',
    allowTrash: false,
    sortOrder: 50,
  },
  {
    key: 'ACCOUNTS',
    name: 'Accounts & Security',
    description:
      'Account and security notices: password resets, sign-in alerts, verification codes, terms-of-service updates, subscription renewals. A genuine security alert for an account you use should be ATTENTION.',
    labelName: 'Accounts',
    defaultAction: 'ARCHIVE',
    allowTrash: false,
    sortOrder: 60,
  },
  {
    key: 'NEWSLETTERS',
    name: 'Newsletters',
    description:
      'Editorial or content mailings that were subscribed to: digests, blogs, community updates, course content. Content, not sales pitches.',
    labelName: 'Newsletters',
    defaultAction: 'ARCHIVE',
    allowTrash: true,
    sortOrder: 70,
  },
  {
    key: 'PROMOTIONS',
    name: 'Promotions',
    description:
      'Marketing, sales, discount codes, product announcements, abandoned-cart nudges, re-engagement and "we miss you" mail.',
    labelName: 'Promotions',
    defaultAction: 'TRASH',
    allowTrash: true,
    sortOrder: 80,
  },
  {
    key: 'NOTIFICATIONS',
    name: 'Notifications',
    description:
      'Automated notifications from apps and services: social networks, calendar, comments, build or deploy status, things already handled elsewhere.',
    labelName: 'Notifications',
    defaultAction: 'ARCHIVE',
    allowTrash: true,
    sortOrder: 90,
  },
  {
    key: 'JUNK',
    name: 'Junk',
    description:
      'Unsolicited cold outreach, scams, phishing-looking mail, obvious spam that got through the filters.',
    labelName: null,
    defaultAction: 'TRASH',
    allowTrash: true,
    sortOrder: 100,
  },
  {
    key: OTHER_CATEGORY,
    name: 'Other',
    description: 'Anything that fits none of the other categories.',
    labelName: 'Other',
    defaultAction: 'KEEP',
    allowTrash: false,
    sortOrder: 110,
  },
];

let seeded = false;

/** Insert any built-in category that is missing. Never overwrites edits. */
export async function ensureCategoriesSeeded(): Promise<void> {
  if (seeded) return;
  const result = await withDatabase(async () => {
    const existing = new Set((await prisma.category.findMany({ select: { key: true } })).map((c) => c.key));
    const missing = BUILT_IN_CATEGORIES.filter((def) => !existing.has(def.key));
    for (const def of missing) {
      await prisma.category.create({
        data: {
          key: def.key,
          name: def.name,
          description: def.description,
          labelName: def.labelName,
          defaultAction: def.defaultAction,
          allowTrash: def.allowTrash,
          builtIn: true,
          sortOrder: def.sortOrder,
        },
      });
    }
  });
  seeded = result.ok;
}

export async function listCategories(includeDisabled = false): Promise<Category[]> {
  await ensureCategoriesSeeded();
  const result = await withDatabase(() =>
    prisma.category.findMany({
      where: includeDisabled ? undefined : { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    }),
  );
  if (result.ok && result.data.length > 0) return result.data;
  // Database missing: fall back to the built-ins so the pipeline still runs.
  return BUILT_IN_CATEGORIES.map((def) => ({
    key: def.key,
    name: def.name,
    description: def.description,
    labelName: def.labelName,
    defaultAction: def.defaultAction,
    allowTrash: def.allowTrash,
    autoTrash: false,
    enabled: true,
    builtIn: true,
    sortOrder: def.sortOrder,
  }));
}

/** Full Gmail label name for a category, e.g. `AutoMail/Finance`. */
export function categoryLabelName(prefix: string, labelName: string): string {
  return `${prefix}/${labelName}`;
}

/** `Finance` -> `FINANCE`, `Client invoices` -> `CLIENT_INVOICES`. */
export function categoryKeyFromName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}
