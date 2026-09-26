import type { Prisma } from '@prisma/client';

import { listAccounts, resolveSelection } from '@/lib/accounts';
import { fail, guard, ok } from '@/lib/api';
import { messageWhere, parseMessageQuery } from '@/lib/messages-query';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeMessage } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

/** The most ids one `fields=ids` answer will carry. */
const MAX_IDS = 5_000;

/**
 * GET /api/messages?view=review|attention|deleted|all&accountId&action&category&decidedBy&status&q&days&page&pageSize
 *
 * With `fields=ids` it answers with every matching id instead of a page of
 * rows, which is how a bulk action covers the whole queue rather than only
 * the page the user happens to be looking at.
 */
export async function GET(request: Request) {
  return guard(async () => {
    const params = new URL(request.url).searchParams;
    const query = parseMessageQuery(params);
    const accounts = await listAccounts();
    if (!query.accountId && !params.get('accountId')) {
      const selection = await resolveSelection(accounts);
      query.accountId = selection.selected?.id ?? null;
    }
    const where = messageWhere(query);

    if (params.get('fields') === 'ids') {
      const idResult = await withDatabase(async () => {
        const [total, rows] = await Promise.all([
          prisma.message.count({ where }),
          prisma.message.findMany({
            where,
            orderBy: { internalDate: 'desc' },
            take: MAX_IDS,
            select: { id: true },
          }),
        ]);
        return { total, rows };
      });
      if (!idResult.ok) return fail('The database could not be reached.', 503);
      return ok({ ids: idResult.data.rows.map((row) => row.id), total: idResult.data.total });
    }

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
