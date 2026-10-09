import { z } from 'zod';

import { listAccounts, resolveSelection } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { JOB_ACTIONS } from '@/lib/job-text';
import { MAX_JOB_IDS, enqueueJob, listJobs, serializeJob } from '@/lib/jobs';
import { messageWhere, parseMessageQuery } from '@/lib/messages-query';
import { prisma, withDatabase } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    action: z.enum(JOB_ACTIONS),
    /** The emails to act on... */
    ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_JOB_IDS).optional(),
    /** ...or everything currently in one of the queues. */
    view: z.enum(['review', 'attention']).optional(),
    /** The mailbox it was started from; "all" or absent means the current selection. */
    accountId: z.string().min(1).max(64).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((body) => Boolean(body.ids) !== Boolean(body.view), {
    message: 'Send either ids or a view, not both.',
  });

/** GET /api/bulk — background jobs still working, and those that finished recently. */
export async function GET() {
  return guard(async () => {
    const result = await withDatabase(() => listJobs());
    if (!result.ok) return fail('The database could not be reached.', 503);
    return ok({
      active: result.data.active.map(serializeJob),
      recent: result.data.recent.map(serializeJob),
    });
  }, 'GET /api/bulk');
}

/**
 * POST /api/bulk { action, ids | view, accountId?, category?, note? }
 *
 * Queues a bulk action and answers straight away. The emails leave the review
 * queues immediately and the work carries on in the server, so the page can
 * be closed. A view queues everything in it, which is how "Trash all" covers
 * thousands of emails without the browser sending their ids.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 256 * 1024);
    if (!parsed.ok) return parsed.response;
    const { action, ids, view, category, note } = parsed.data;

    const accounts = await listAccounts();
    const accountId =
      parsed.data.accountId === 'all'
        ? null
        : (parsed.data.accountId ?? (await resolveSelection(accounts)).selected?.id ?? null);
    if (accountId && !accounts.some((account) => account.id === accountId)) {
      return fail('No such account.', 404);
    }

    let targets = ids ?? [];
    if (view) {
      const query = { ...parseMessageQuery(new URLSearchParams()), view, accountId };
      const rows = await withDatabase(() =>
        prisma.message.findMany({
          where: messageWhere(query),
          orderBy: { internalDate: 'desc' },
          take: MAX_JOB_IDS,
          select: { id: true },
        }),
      );
      if (!rows.ok) return fail('The database could not be reached.', 503);
      targets = rows.data.map((row) => row.id);
    }
    if (targets.length === 0) return fail('There is nothing to do.', 409);

    const job = await withDatabase(() => enqueueJob({ accountId, action, ids: targets, category, note }));
    if (!job.ok) return fail('The database could not be reached.', 503);
    if (job.data.total === 0) return fail('Those emails are already being handled.', 409);
    return ok({ job: serializeJob(job.data) }, { status: 202 });
  }, 'POST /api/bulk');
}
