import { z } from 'zod';

import { getAccount } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { isGeminiConfigured } from '@/lib/gemini';
import { regenerateLearnedNotes } from '@/lib/pipeline/learning';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const bodySchema = z.object({
  accountId: z.string().min(1).max(64),
});

/**
 * POST /api/rules/learn { accountId }
 *
 * Distils one mailbox's review history into its own learned preferences.
 * Mailbox-scoped on purpose: a work address should not learn from how
 * personal mail was triaged.
 */
export async function POST(request: Request) {
  return guard(async () => {
    if (!isGeminiConfigured()) return fail('GEMINI_API_KEY is not configured.', 503);

    const parsed = await readJson(request, bodySchema, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    if (!(await getAccount(parsed.data.accountId))) return fail('No such account.', 404);

    const result = await regenerateLearnedNotes(parsed.data.accountId);
    if (!result.ok) return fail(result.reason ?? 'The notes could not be generated.', 422);
    return ok({ notes: result.notes, costUsd: result.costUsd });
  }, 'POST /api/rules/learn');
}
