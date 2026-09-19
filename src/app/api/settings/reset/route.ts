import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { listAccounts } from '@/lib/accounts';
import { isRunning } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  what: z.enum(['history']),
  confirm: z.literal('CLEAR'),
});

/**
 * POST /api/settings/reset { what: "history", confirm: "CLEAR" }
 *
 * Deletes every processed message, run, Gemini call and backlog snapshot.
 * Accounts, rules, categories and settings stay; Gmail is not touched. The
 * next run rebuilds the backlog and starts again.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    const accounts = await listAccounts();
    if (accounts.some((a) => isRunning(a.id))) return fail('A run is in progress; try again when it finishes.', 409);

    const result = await withDatabase(() =>
      prisma.$transaction([
        prisma.message.deleteMany(),
        prisma.aiCall.deleteMany(),
        prisma.run.deleteMany(),
        prisma.backlogItem.deleteMany(),
        prisma.suggestionDismissal.deleteMany(),
        prisma.account.updateMany({
          data: { backlogBuiltAt: null, backlogDone: false, backlogEstimate: null, lastNewLaneAt: null },
        }),
      ]),
    );
    if (!result.ok) return fail('The history could not be cleared.', 500);
    return ok({ cleared: true });
  }, 'POST /api/settings/reset');
}
