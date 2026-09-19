import type { Prisma } from '@prisma/client';

import { listAccounts, resolveSelection } from '@/lib/accounts';
import { fail, guard, ok } from '@/lib/api';
import { messageWhere, parseMessageQuery } from '@/lib/messages-query';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeMessage } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

/**
 * GET /api/messages?view=review|attention|deleted|all&accountId&action&category&decidedBy&status&q&days&page&pageSize
 */
export async function GET(request: Request) {
  return guard(async () => {
    const query = parseMessageQuery(new URL(request.url).searchParams);
    const accounts = await listAccounts();
    if (!query.accountId && !new URL(request.url).searchParams.get('accountId')) {
      const selection = await resolveSelection(accounts);
      query.accountId = selection.selected?.id ?? null;
    }
    const where = messageWhere(query);
    const orderBy: Prisma.MessageOrderByWithRelationInput =
      query.view === 'all' ? { processedAt: 'desc' } : { internalDate: 'desc' };

    const result = await withDatabase(async () => {
      const [total, items] = await Promise.all([
        prisma.message.count({ where }),
        prisma.message.findMany({
          where,
          orderBy,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);
      return { total, items };
    });
    if (!result.ok) return fail('The database could not be reached.', 503);

    const emailById = new Map(accounts.map((a) => [a.id, a.email]));
    return ok({
      items: result.data.items.map((m) => serializeMessage(m, emailById.get(m.accountId) ?? '')),
      total: result.data.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  }, 'GET /api/messages');
}
