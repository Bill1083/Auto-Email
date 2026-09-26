import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { BULK_CHUNK_LIMIT, FeedbackError, bulkAction, type BulkOutcome } from '@/lib/pipeline/feedback';
import { ACTIONS } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const bodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(BULK_CHUNK_LIMIT),
  action: z.enum([...ACTIONS, 'DONE', 'CONFIRM', 'UNDO']),
  category: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(500).optional(),
});

/**
 * POST /api/messages/bulk { ids, action, category?, note? }
 *
 * The same operations as the single-message routes, applied to many, with the
 * mailbox work grouped into as few calls as the provider allows. Always
 * answers with what was done, what failed and what is left, so the caller can
 * report honest progress and send the rest.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 128 * 1024);
    if (!parsed.ok) return parsed.response;
    const { ids, action, category, note } = parsed.data;

    let outcome: BulkOutcome;
    try {
      outcome = await bulkAction(ids, { action, category, note });
    } catch (error) {
      if (error instanceof FeedbackError) return fail(error.message, error.status);
      throw error;
    }

    if (outcome.done.length === 0 && outcome.failed.length > 0) {
      return fail(
        outcome.failed[0].error,
        409,
        outcome.failed.map((entry) => ({ path: entry.id, message: entry.error })),
      );
    }
    return ok(outcome);
  }, 'POST /api/messages/bulk');
}
