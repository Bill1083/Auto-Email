import { fail, guard, ok } from '@/lib/api';
import { isRunning } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeAiCall, serializeRun } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

/** GET /api/runs/:id — one run with its Gemini calls. */
export async function GET(_request: Request, { params }: RouteContext) {
  return guard(async () => {
    const result = await withDatabase(() =>
      prisma.run.findUnique({
        where: { id: params.id },
        include: {
          account: { select: { email: true } },
          calls: { orderBy: { createdAt: 'asc' } },
        },
      }),
    );
    if (!result.ok) return fail('The database could not be reached.', 503);
    if (!result.data) return fail('No such run.', 404);
    const run = result.data;
    return ok({
      run: { ...serializeRun(run, run.account.email), running: isRunning(run.accountId) && run.status === 'RUNNING' },
      calls: run.calls.map(serializeAiCall),
    });
  }, 'GET /api/runs/:id');
}
