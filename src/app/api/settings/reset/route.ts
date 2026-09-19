import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { getAccount, listAccounts } from '@/lib/accounts';
import { isRunning } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  what: z.enum(['history']),
  confirm: z.literal('CLEAR'),
  /** The mailbox to clear. Omitted means every mailbox. */
  accountId: z.string().min(1).max(64).optional(),
});

/**
 * POST /api/settings/reset { what: "history", confirm: "CLEAR", accountId? }
 *
 * Deletes processed messages, runs, Gemini calls and the backlog snapshot for
 * one mailbox, or for every mailbox when none is named. Accounts, rules,
 * categories and settings stay; Gmail is not touched. The next run rebuilds
 * the backlog and starts again.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    const { accountId } = parsed.data;

    if (accountId) {
      if (!(await getAccount(accountId))) return fail('No such account.', 404);
      if (isRunning(accountId)) return fail('A run is in progress; try again when it finishes.', 409);
    } else {
      const accounts = await listAccounts();
      if (accounts.some((a) => isRunning(a.id))) {
        return fail('A run is in progress; try again when it finishes.', 409);
      }
    }

    const where = accountId ? { accountId } : {};
    const result = await withDatabase(() =>
      prisma.$transaction([
        prisma.message.deleteMany({ where }),
        prisma.aiCall.deleteMany({ where }),
        prisma.run.deleteMany({ where }),
        prisma.backlogItem.deleteMany({ where }),
        ...(accountId ? [] : [prisma.suggestionDismissal.deleteMany()]),
        prisma.account.updateMany({
          where: accountId ? { id: accountId } : {},
          data: { backlogBuiltAt: null, backlogDone: false, backlogEstimate: null, lastNewLaneAt: null },
        }),
      ]),
    );
    if (!result.ok) return fail('The history could not be cleared.', 500);
    return ok({ cleared: true, accountId: accountId ?? null });
  }, 'POST /api/settings/reset');
}
