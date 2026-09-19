import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { ReauthRequiredError } from '@/lib/mail/provider';
import { FeedbackError, handleFeedback, undoMessage } from '@/lib/pipeline/feedback';
import { ACTIONS } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const bodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
  action: z.enum([...ACTIONS, 'DONE', 'CONFIRM', 'UNDO']),
  category: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(500).optional(),
});

/**
 * POST /api/messages/bulk { ids, action, category?, note? }
 *
 * The same operations as the single-message routes, applied to many. Each id
 * is processed independently so one failure does not abort the rest.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 128 * 1024);
    if (!parsed.ok) return parsed.response;
    const { ids, action, category, note } = parsed.data;

    const done: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of [...new Set(ids)]) {
      try {
        if (action === 'UNDO') await undoMessage(id);
        else await handleFeedback(id, { action, category, note });
        done.push(id);
      } catch (error) {
        const message =
          error instanceof FeedbackError
            ? error.message
            : error instanceof ReauthRequiredError
              ? 'Account needs to be reconnected.'
              : error instanceof Error
                ? error.message
                : 'Unknown error';
        failed.push({ id, error: message });
        // Once the mailbox connection is gone, every remaining id will fail too.
        if (error instanceof ReauthRequiredError) break;
      }
    }
    if (done.length === 0 && failed.length > 0) {
      return fail(failed[0].error, 409, failed.map((f) => ({ path: f.id, message: f.error })));
    }
    return ok({ done, failed });
  }, 'POST /api/messages/bulk');
}
