import { getAccount } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { ReauthRequiredError } from '@/lib/mail/provider';
import { FeedbackError, feedbackBodySchema, handleFeedback } from '@/lib/pipeline/feedback';
import { serializeMessage } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

/** POST /api/messages/:id/feedback { action, category?, note? } */
export async function POST(request: Request, { params }: RouteContext) {
  return guard(async () => {
    const parsed = await readJson(request, feedbackBodySchema, 16 * 1024);
    if (!parsed.ok) return parsed.response;
    try {
      const message = await handleFeedback(params.id, parsed.data);
      const account = await getAccount(message.accountId);
      return ok({ message: serializeMessage(message, account?.email ?? '') });
    } catch (error) {
      if (error instanceof FeedbackError) return fail(error.message, error.status);
      if (error instanceof ReauthRequiredError) return fail('This account needs to be reconnected.', 409);
      throw error;
    }
  }, 'POST /api/messages/:id/feedback');
}
