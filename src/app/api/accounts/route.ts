import { z } from 'zod';

import { listAccounts } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { env } from '@/lib/env';
import { MOCK_ACCOUNT_EMAIL } from '@/lib/mail/mock';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeAccount } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

/** GET /api/accounts — every connected account, secrets stripped. */
export async function GET() {
  return guard(async () => {
    const accounts = await listAccounts();
    return ok({ accounts: accounts.map(serializeAccount) });
  }, 'GET /api/accounts');
}

const bodySchema = z.object({
  kind: z.literal('mock'),
});

/**
 * POST /api/accounts { kind: "mock" }
 *
 * Creates the fixture mailbox account. Only available with MOCK_MAIL=true;
 * real Gmail accounts are added through /api/google/start.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    if (!env.mockMail) {
      return fail('MOCK_MAIL is off. Set MOCK_MAIL=true in .env to use the demo mailbox.', 403);
    }
    const saved = await withDatabase(() =>
      prisma.account.upsert({
        where: { email: MOCK_ACCOUNT_EMAIL },
        create: {
          provider: 'mock',
          email: MOCK_ACCOUNT_EMAIL,
          displayName: 'Demo mailbox',
          status: 'ACTIVE',
          lastSyncAt: new Date(),
        },
        update: { status: 'ACTIVE', lastError: null },
      }),
    );
    if (!saved.ok) return fail('The database could not be reached.', 503);
    return ok({ account: serializeAccount(saved.data) }, { status: 201 });
  }, 'POST /api/accounts');
}
