import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { acceptSuggestion, categoryNudges, suggestRules } from '@/lib/pipeline/learning';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeRule } from '@/lib/serialize';
import { getSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/**
 * GET /api/rules/suggestions?accountId= — learned rule suggestions and
 * category nudges, using that mailbox's own suggestion threshold.
 */
export async function GET(request: Request) {
  return guard(async () => {
    const raw = new URL(request.url).searchParams.get('accountId');
    const accountId = raw && raw !== 'all' ? raw : null;
    const settings = await getSettings(accountId);
    const [suggestions, nudges] = await Promise.all([
      suggestRules(accountId, settings.suggestionThreshold),
      categoryNudges(),
    ]);
    return ok({ suggestions, nudges, threshold: settings.suggestionThreshold });
  }, 'GET /api/rules/suggestions');
}

const bodySchema = z.object({
  key: z.string().min(1).max(300),
  decision: z.enum(['accept', 'dismiss']),
  /** Accept as a review-first rule even if auto-trash was suggested. */
  autoApply: z.boolean().optional(),
});

/** Suggestion keys are `sender:<accountId>:<address>`. */
function accountIdFromKey(key: string): string | null {
  const match = /^sender:([^:]+):/.exec(key);
  return match ? match[1] : null;
}

/** POST /api/rules/suggestions { key, decision } */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    const { key, decision } = parsed.data;

    if (decision === 'dismiss') {
      const saved = await withDatabase(() =>
        prisma.suggestionDismissal.upsert({ where: { key }, create: { key }, update: {} }),
      );
      if (!saved.ok) return fail('The database could not be reached.', 503);
      return ok({ dismissed: key });
    }

    // Re-derive the suggestion with the threshold of the mailbox it belongs to.
    const accountId = accountIdFromKey(key);
    if (!accountId) return fail('That suggestion is no longer available.', 404);
    const settings = await getSettings(accountId);
    const suggestions = await suggestRules(accountId, settings.suggestionThreshold);
    const suggestion = suggestions.find((s) => s.key === key);
    if (!suggestion) return fail('That suggestion is no longer available.', 404);
    if (parsed.data.autoApply !== undefined) suggestion.autoApply = parsed.data.autoApply;

    const created = await withDatabase(() => acceptSuggestion(suggestion, 'user'));
    if (!created.ok) return fail('The rule could not be created.', 500);
    return ok({ rule: serializeRule(created.data) }, { status: 201 });
  }, 'POST /api/rules/suggestions');
}
