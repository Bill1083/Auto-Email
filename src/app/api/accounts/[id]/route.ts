import { z } from 'zod';

import { getAccount } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { decryptSecret } from '@/lib/crypto';
import { revokeToken } from '@/lib/mail/gmail/oauth';
import { isRunning } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeAccount } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

const patchSchema = z
  .object({
    status: z.enum(['ACTIVE', 'PAUSED']),
    dailyLimit: z.number().int().min(0).max(5_000).nullable(),
    displayName: z.string().trim().max(80).nullable(),
    resetBacklog: z.literal(true),
  })
  .partial()
  .strict();

/** PATCH /api/accounts/:id — pause/resume, per-account cap, backlog reset. */
export async function PATCH(request: Request, { params }: RouteContext) {
  return guard(async () => {
    const parsed = await readJson(request, patchSchema, 16 * 1024);
    if (!parsed.ok) return parsed.response;
    const account = await getAccount(params.id);
    if (!account) return fail('No such account.', 404);

    const { resetBacklog, status, ...rest } = parsed.data;
    const data: Record<string, unknown> = { ...rest };
    if (status) {
      // Resuming a broken account does not fix its credentials.
      if (status === 'ACTIVE' && account.status === 'NEEDS_REAUTH') {
        return fail('This account needs to be reconnected, not resumed.', 409);
      }
      data.status = status;
    }
    if (resetBacklog) {
      if (isRunning(account.id)) return fail('A run is in progress; try again when it finishes.', 409);
      await withDatabase(() => prisma.backlogItem.deleteMany({ where: { accountId: account.id } }));
      data.backlogBuiltAt = null;
      data.backlogDone = false;
      data.backlogEstimate = null;
    }

    const updated = await withDatabase(() =>
      prisma.account.update({ where: { id: account.id }, data }),
    );
    if (!updated.ok) return fail('The database could not be reached.', 503);
    return ok({ account: serializeAccount(updated.data) });
  }, 'PATCH /api/accounts/:id');
}

/**
 * DELETE /api/accounts/:id
 *
 * Disconnects the mailbox: revokes the Google token (best effort), then
 * removes the account and its history. Labels already applied in Gmail are
 * left exactly as they are.
 */
export async function DELETE(_request: Request, { params }: RouteContext) {
  return guard(async () => {
    const account = await getAccount(params.id);
    if (!account) return fail('No such account.', 404);
    if (isRunning(account.id)) return fail('A run is in progress; try again when it finishes.', 409);

    if (account.provider === 'gmail' && account.refreshTokenEnc) {
      try {
        await revokeToken(await decryptSecret(account.refreshTokenEnc));
      } catch {
        // An undecryptable token cannot be revoked; deleting the row is still right.
      }
    }
    const deleted = await withDatabase(() => prisma.account.delete({ where: { id: account.id } }));
    if (!deleted.ok) return fail('The account could not be deleted.', 500);
    return ok({ deleted: account.id });
  }, 'DELETE /api/accounts/:id');
}
