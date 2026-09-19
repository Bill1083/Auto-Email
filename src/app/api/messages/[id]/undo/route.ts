import { getAccount } from '@/lib/accounts';
import { fail, guard, ok } from '@/lib/api';
import { ReauthRequiredError } from '@/lib/mail/provider';
import { FeedbackError, undoMessage } from '@/lib/pipeline/feedback';
import { serializeMessage } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

/** POST /api/messages/:id/undo — reverse every change made to this message. */
export async function POST(_request: Request, { params }: RouteContext) {
  return guard(async () => {
    try {
      const message = await undoMessage(params.id);
      const account = await getAccount(message.accountId);
      return ok({ message: serializeMessage(message, account?.email ?? '') });
    } catch (error) {
      if (error instanceof FeedbackError) return fail(error.message, error.status);
      if (error instanceof ReauthRequiredError) return fail('This account needs to be reconnected.', 409);
      throw error;
    }
  }, 'POST /api/messages/:id/undo');
}
