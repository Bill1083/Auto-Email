import { z } from 'zod';

import { ACCOUNT_COOKIE, ALL_ACCOUNTS, getAccount } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  accountId: z.string().min(1).max(64),
});

/** POST /api/accounts/select { accountId } — remember which mailbox the dashboard shows. */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    const { accountId } = parsed.data;
    if (accountId !== ALL_ACCOUNTS && !(await getAccount(accountId))) {
      return fail('No such account.', 404);
    }
    const response = ok({ selected: accountId });
    response.cookies.set(ACCOUNT_COOKIE, accountId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.appUrl.startsWith('https://'),
      path: '/',
      maxAge: 365 * 86_400,
    });
    return response;
  }, 'POST /api/accounts/select');
}
