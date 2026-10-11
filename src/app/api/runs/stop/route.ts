import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { requestStop } from '@/lib/pipeline/run';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  accountId: z.string().min(1).max(64),
});

/**
 * POST /api/runs/stop { accountId }
 *
 * Asks that mailbox's run to stop at its next checkpoint. What it already
 * recorded stays; the rest is picked up on the next run.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    if (!requestStop(parsed.data.accountId)) return fail('That mailbox has no run in progress.', 409);
    return ok({ stopping: true }, { status: 202 });
  }, 'POST /api/runs/stop');
}
