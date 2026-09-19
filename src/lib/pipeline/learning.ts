/**
 * Learning from corrections.
 *
 * Three mechanisms, cheapest first:
 *  1. Recent corrections relevant to a batch are shown to the model as
 *     worked examples (`relevantExamples`).
 *  2. Per-sender agreement/disagreement is aggregated into rule suggestions
 *     the user accepts with one click (`suggestRules`), or that are created
 *     automatically when `autoPromoteRules` is on.
 *  3. The whole correction history is periodically distilled by the model
 *     into a short "learned preferences" list kept in Settings
 *     (`regenerateLearnedNotes`).
 */

import { z } from 'zod';

import { Type, generateStructured, type Schema } from '@/lib/gemini';
import { computeCostUsd } from '@/lib/pipeline/cost';
import { prisma, withDatabase } from '@/lib/prisma';
import { getSettings, updateSettings, type AppSettings } from '@/lib/settings';
import { ACTIONS, type Action, type RawEmail } from '@/lib/types';

export interface FeedbackExample {
  fromAddress: string;
  subject: string;
  aiAction: string;
  aiCategory: string | null;
  userAction: string;
  userCategory: string | null;
  note: string | null;
}

const EXAMPLE_SELECT = {
  fromAddress: true,
  fromDomain: true,
  subject: true,
  action: true,
  category: true,
  userAction: true,
  userCategory: true,
  feedbackNote: true,
  feedbackAt: true,
} as const;

type ExampleRow = {
  fromAddress: string;
  fromDomain: string;
  subject: string;
  action: string;
  category: string;
  userAction: string | null;
  userCategory: string | null;
  feedbackNote: string | null;
  feedbackAt: Date | null;
};

function toExample(row: ExampleRow): FeedbackExample {
  return {
    fromAddress: row.fromAddress,
    subject: row.subject.slice(0, 80),
    aiAction: row.action,
    aiCategory: row.category,
    userAction: row.userAction ?? row.action,
    userCategory: row.userCategory,
    note: row.feedbackNote ? row.feedbackNote.slice(0, 160) : null,
  };
}

/**
 * Corrections for this batch: anything from the same senders or domains
 * first, then the most recent corrections overall, deduplicated.
 */
export async function relevantExamples(
  accountId: string,
  emails: RawEmail[],
  limit = 20,
): Promise<FeedbackExample[]> {
  const domains = [...new Set(emails.map((e) => e.from.domain).filter(Boolean))];
  const addresses = [...new Set(emails.map((e) => e.from.address).filter(Boolean))];

  const result = await withDatabase(async () => {
    const matching = await prisma.message.findMany({
      where: {
        accountId,
        userAction: { not: null },
        OR: [{ fromAddress: { in: addresses } }, { fromDomain: { in: domains } }],
      },
      orderBy: { feedbackAt: 'desc' },
      take: Math.ceil(limit / 2),
      select: EXAMPLE_SELECT,
    });
    const recent = await prisma.message.findMany({
      where: { accountId, userAction: { not: null } },
      orderBy: { feedbackAt: 'desc' },
      take: limit,
      select: EXAMPLE_SELECT,
    });
    return [...matching, ...recent];
  });
  if (!result.ok) return [];

  const seen = new Set<string>();
  const out: FeedbackExample[] = [];
  for (const row of result.data) {
    const key = `${row.fromAddress}|${row.subject}|${row.userAction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Confirmations of TRASH proposals are useful too, but corrections first.
    out.push(toExample(row));
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule suggestions
// ---------------------------------------------------------------------------

export interface RuleSuggestion {
  key: string;
  accountId: string | null;
  kind: 'SENDER';
  pattern: string;
  action: Action;
  category: string;
  /** Suggest trashing without review: the user confirmed every proposal. */
  autoApply: boolean;
  evidence: {
    total: number;
    confirmed: number;
    corrected: number;
    sampleSubject: string;
    lastAt: string;
  };
}

interface SenderBucket {
  fromAddress: string;
  total: number;
  byAction: Record<string, number>;
  byCategory: Record<string, number>;
  aiTrashConfirmed: number;
  corrected: number;
  sampleSubject: string;
  lastAt: Date;
}

/**
 * Aggregate feedback per sender. A sender whose corrections all point the
 * same way `threshold` times becomes a suggestion; a sender whose TRASH
 * proposals were all confirmed becomes an auto-trash suggestion.
 */
export async function suggestRules(
  accountId: string | null,
  threshold: number,
): Promise<RuleSuggestion[]> {
  const result = await withDatabase(async () => {
    const rows = await prisma.message.findMany({
      where: { ...(accountId ? { accountId } : {}), userAction: { not: null } },
      orderBy: { feedbackAt: 'desc' },
      take: 2_000,
      select: { ...EXAMPLE_SELECT, accountId: true },
    });
    const rules = await prisma.rule.findMany({
      where: { kind: 'SENDER', enabled: true },
      select: { pattern: true, accountId: true },
    });
    const dismissed = await prisma.suggestionDismissal.findMany({ select: { key: true } });
    return { rows, rules, dismissed: new Set(dismissed.map((d) => d.key)) };
  });
  if (!result.ok) return [];

  const covered = new Set(result.data.rules.map((r) => `${r.accountId ?? 'all'}:${r.pattern.toLowerCase()}`));
  const buckets = new Map<string, SenderBucket & { accountId: string }>();

  for (const row of result.data.rows) {
    const userAction = row.userAction as string;
    const key = `${row.accountId}:${row.fromAddress}`;
    const bucket =
      buckets.get(key) ??
      ({
        accountId: row.accountId,
        fromAddress: row.fromAddress,
        total: 0,
        byAction: {},
        byCategory: {},
        aiTrashConfirmed: 0,
        corrected: 0,
        sampleSubject: row.subject,
        lastAt: row.feedbackAt ?? new Date(0),
      } as SenderBucket & { accountId: string });
    bucket.total += 1;
    bucket.byAction[userAction] = (bucket.byAction[userAction] ?? 0) + 1;
    const cat = row.userCategory ?? row.category;
    bucket.byCategory[cat] = (bucket.byCategory[cat] ?? 0) + 1;
    if (row.action === 'TRASH' && userAction === 'TRASH') bucket.aiTrashConfirmed += 1;
    if (row.action !== userAction) bucket.corrected += 1;
    buckets.set(key, bucket);
  }

  const suggestions: RuleSuggestion[] = [];
  for (const bucket of buckets.values()) {
    const scopeKey = `${bucket.accountId}:${bucket.fromAddress.toLowerCase()}`;
    if (covered.has(scopeKey) || covered.has(`all:${bucket.fromAddress.toLowerCase()}`)) continue;
    const suggestionKey = `sender:${scopeKey}`;
    if (result.data.dismissed.has(suggestionKey)) continue;

    const actions = Object.entries(bucket.byAction).sort((a, b) => b[1] - a[1]);
    const [topAction, topCount] = actions[0] as [string, number];
    const unanimous = actions.length === 1;
    if (!unanimous || topCount < threshold) continue;
    if (!(ACTIONS as readonly string[]).includes(topAction)) continue;

    const category = Object.entries(bucket.byCategory).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'OTHER';
    const autoApply = topAction === 'TRASH' && bucket.aiTrashConfirmed >= threshold && bucket.corrected === 0;

    suggestions.push({
      key: suggestionKey,
      accountId: bucket.accountId,
      kind: 'SENDER',
      pattern: bucket.fromAddress,
      action: topAction as Action,
      category,
      autoApply,
      evidence: {
        total: bucket.total,
        confirmed: bucket.total - bucket.corrected,
        corrected: bucket.corrected,
        sampleSubject: bucket.sampleSubject.slice(0, 80),
        lastAt: bucket.lastAt.toISOString(),
      },
    });
  }

  return suggestions.sort((a, b) => b.evidence.total - a.evidence.total).slice(0, 50);
}

export async function acceptSuggestion(suggestion: RuleSuggestion, source: 'user' | 'learned' = 'user') {
  return prisma.rule.create({
    data: {
      accountId: suggestion.accountId,
      kind: suggestion.kind,
      pattern: suggestion.pattern,
      action: suggestion.action,
      category: suggestion.category,
      autoApply: suggestion.autoApply,
      note: `Suggested from ${suggestion.evidence.total} reviewed emails.`,
      source,
    },
  });
}

/** With `autoPromoteRules` on, suggestions become rules without asking. */
export async function autoPromoteSuggestions(accountId: string, settings: AppSettings): Promise<number> {
  if (!settings.autoPromoteRules) return 0;
  const suggestions = await suggestRules(accountId, settings.suggestionThreshold);
  let created = 0;
  for (const suggestion of suggestions) {
    const write = await withDatabase(() => acceptSuggestion(suggestion, 'learned'));
    if (write.ok) created += 1;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Category-level auto-trash nudges
// ---------------------------------------------------------------------------

export interface CategoryNudge {
  category: string;
  confirmed: number;
  rescued: number;
}

/** Categories where every TRASH proposal in the last 90 days was confirmed. */
export async function categoryNudges(minConfirmed = 20): Promise<CategoryNudge[]> {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const result = await withDatabase(async () => {
    const rows = await prisma.message.groupBy({
      by: ['category', 'userAction'],
      where: { action: 'TRASH', userAction: { not: null }, feedbackAt: { gte: since } },
      _count: { _all: true },
    });
    const categories = await prisma.category.findMany({
      where: { allowTrash: true, autoTrash: false, enabled: true },
      select: { key: true },
    });
    return { rows, eligible: new Set(categories.map((c) => c.key)) };
  });
  if (!result.ok) return [];

  const stats = new Map<string, CategoryNudge>();
  for (const row of result.data.rows) {
    if (!result.data.eligible.has(row.category)) continue;
    const entry = stats.get(row.category) ?? { category: row.category, confirmed: 0, rescued: 0 };
    if (row.userAction === 'TRASH') entry.confirmed += row._count._all;
    else entry.rescued += row._count._all;
    stats.set(row.category, entry);
  }
  return [...stats.values()].filter((s) => s.confirmed >= minConfirmed && s.rescued === 0);
}

// ---------------------------------------------------------------------------
// Learned notes
// ---------------------------------------------------------------------------

const notesSchema = z.object({
  notes: z.array(z.string().min(3).max(200)).max(15),
});

const NOTES_GEMINI_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: ['notes'],
  properties: {
    notes: {
      type: Type.ARRAY,
      description: 'Up to 12 short, general preference statements. Empty when nothing general can be said.',
      items: { type: Type.STRING },
    },
  },
};

export interface LearnedNotesResult {
  ok: boolean;
  notes: string;
  reason: string | null;
  costUsd: number;
}

/**
 * Distil one mailbox's correction history into general preferences. Runs
 * weekly when `learnedNotesAuto` is on, or on demand from the Rules page.
 *
 * Scoped to a single mailbox on purpose: the notes are sent with that
 * mailbox's batches, so a work address never learns from a personal one.
 */
export async function regenerateLearnedNotes(accountId: string): Promise<LearnedNotesResult> {
  const settings = await getSettings(accountId);
  const rows = await withDatabase(() =>
    prisma.message.findMany({
      where: { accountId, userAction: { not: null } },
      orderBy: { feedbackAt: 'desc' },
      take: 200,
      select: EXAMPLE_SELECT,
    }),
  );
  if (!rows.ok) return { ok: false, notes: settings.learnedNotes, reason: 'Database unavailable.', costUsd: 0 };
  if (rows.data.length < 5) {
    return {
      ok: false,
      notes: settings.learnedNotes,
      reason: 'Fewer than 5 reviewed decisions so far; nothing general to learn yet.',
      costUsd: 0,
    };
  }

  const history = rows.data
    .map(toExample)
    .map((ex) => {
      const chosen = `${ex.userAction}${ex.userCategory ? ` (${ex.userCategory})` : ''}`;
      const same = ex.aiAction === ex.userAction && (!ex.userCategory || ex.userCategory === ex.aiCategory);
      return `- ${ex.fromAddress} | "${ex.subject}" | proposed ${ex.aiAction} (${ex.aiCategory}) | ${same ? 'confirmed' : `changed to ${chosen}`}${ex.note ? ` | note: ${ex.note}` : ''}`;
    })
    .join('\n');

  const outcome = await generateStructured({
    systemInstruction:
      'You maintain a short list of general email preferences for one person, inferred from how they reviewed an automated triage system\'s decisions. Write statements that generalise beyond single senders (e.g. "Order and shipping confirmations can be archived, not trashed", "Newsletters about software engineering are worth keeping"). Do not invent preferences the evidence does not support. Prefer 5 to 10 statements; fewer is fine.',
    prompt: `EXISTING NOTES (revise, merge or drop as the evidence warrants):\n${settings.learnedNotes || '(none)'}\n\nREVIEW HISTORY (newest first):\n${history}`,
    schema: NOTES_GEMINI_SCHEMA,
    validator: notesSchema,
    model: settings.geminiModel,
    temperature: 0.3,
    maxOutputTokens: 2_048,
  });

  const costUsd = computeCostUsd(outcome.usage, {
    inputPerM: settings.priceInputPerM,
    outputPerM: settings.priceOutputPerM,
  });
  await withDatabase(() =>
    prisma.aiCall.create({
      data: {
        accountId,
        purpose: 'learn',
        model: outcome.model,
        emailCount: rows.data.length,
        promptTokens: outcome.usage.promptTokens,
        outputTokens: outcome.usage.outputTokens,
        thoughtTokens: outcome.usage.thoughtTokens,
        cachedTokens: outcome.usage.cachedTokens,
        costUsd,
        latencyMs: outcome.latencyMs,
        ok: outcome.ok,
        errorCode: outcome.ok ? null : outcome.code,
      },
    }),
  );

  if (!outcome.ok) {
    return { ok: false, notes: settings.learnedNotes, reason: outcome.reason, costUsd };
  }

  const notes = outcome.data.notes.map((n) => `- ${n.trim().replace(/^[-*]\s*/, '')}`).join('\n');
  await updateSettings(
    { learnedNotes: notes, learnedNotesUpdatedAt: new Date().toISOString() },
    accountId,
  );
  return { ok: true, notes, reason: null, costUsd };
}
