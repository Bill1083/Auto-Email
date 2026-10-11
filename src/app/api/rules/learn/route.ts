import { z } from 'zod';

import { getAccount } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { isGeminiConfigured } from '@/lib/gemini';
import { enqueueLearn, serializeJob } from '@/lib/jobs';
import { withDatabase } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  accountId: z.string().min(1).max(64),
});

/**
 * POST /api/rules/learn { accountId }
 *
 * Queues a job that distils one mailbox's review history into its own
 * learned preferences, and answers at once; the model call can take a while
 * and finishes whether or not the page stays open. Mailbox-scoped on purpose:
 * a work address should not learn from how personal mail was triaged.
 */
export async function POST(request: Request) {
  return guard(async () => {
    if (!isGeminiConfigured()) return fail('GEMINI_API_KEY is not configured.', 503);

    const parsed = await readJson(request, bodySchema, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    const account = await getAccount(parsed.data.accountId);
    if (!account) return fail('No such account.', 404);

    const job = await withDatabase(() => enqueueLearn(account.id));
    if (!job.ok) return fail('The database could not be reached.', 503);
    return ok({ job: serializeJob(job.data, account.email) }, { status: 202 });
  }, 'POST /api/rules/learn');
}
