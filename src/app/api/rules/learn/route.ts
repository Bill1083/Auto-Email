import { fail, guard, ok } from '@/lib/api';
import { isGeminiConfigured } from '@/lib/gemini';
import { regenerateLearnedNotes } from '@/lib/pipeline/learning';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

/** POST /api/rules/learn — distil the review history into learned preferences. */
export async function POST() {
  return guard(async () => {
    if (!isGeminiConfigured()) return fail('GEMINI_API_KEY is not configured.', 503);
    const result = await regenerateLearnedNotes(null);
    if (!result.ok) return fail(result.reason ?? 'The notes could not be generated.', 422);
    return ok({ notes: result.notes, costUsd: result.costUsd });
  }, 'POST /api/rules/learn');
}
