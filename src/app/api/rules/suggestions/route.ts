import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { acceptSuggestion, categoryNudges, suggestRules } from '@/lib/pipeline/learning';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeRule } from '@/lib/serialize';
import { getSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/** GET /api/rules/suggestions?accountId= — learned rule suggestions and category nudges. */
export async function GET(request: Request) {
  return guard(async () => {
    const accountId = new URL(request.url).searchParams.get('accountId');
    const settings = await getSettings();
    const [suggestions, nudges] = await Promise.all([
      suggestRules(accountId && accountId !== 'all' ? accountId : null, settings.suggestionThreshold),
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

    const settings = await getSettings();
    const suggestions = await suggestRules(null, settings.suggestionThreshold);
    const suggestion = suggestions.find((s) => s.key === key);
    if (!suggestion) return fail('That suggestion is no longer available.', 404);
    if (parsed.data.autoApply !== undefined) suggestion.autoApply = parsed.data.autoApply;

    const created = await withDatabase(() => acceptSuggestion(suggestion, 'user'));
    if (!created.ok) return fail('The rule could not be created.', 500);
    return ok({ rule: serializeRule(created.data) }, { status: 201 });
  }, 'POST /api/rules/suggestions');
}
