import { getAccount, providerFor } from '@/lib/accounts';
import { fail, guard, ok } from '@/lib/api';
import { ReauthRequiredError } from '@/lib/mail/provider';
import { prisma, withDatabase } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

/**
 * GET /api/messages/:id/body
 *
 * Fetches a longer excerpt straight from the mailbox for the preview pane.
 * Bodies are never stored locally.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  return guard(async () => {
    const found = await withDatabase(() => prisma.message.findUnique({ where: { id: params.id } }));
    if (!found.ok) return fail('The database could not be reached.', 503);
    if (!found.data) return fail('No such message.', 404);
    const account = await getAccount(found.data.accountId);
    if (!account) return fail('The account for this message no longer exists.', 404);

    try {
      const body = await providerFor(account).fetchBody(found.data.gmailId, 6_000);
      if (body === null) return fail('This message no longer exists in the mailbox.', 410);
      return ok({ body });
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        return fail('This account needs to be reconnected.', 409);
      }
      throw error;
    }
  }, 'GET /api/messages/:id/body');
}
