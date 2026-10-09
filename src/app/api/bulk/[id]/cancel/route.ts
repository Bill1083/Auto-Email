import { fail, guard, ok } from '@/lib/api';
import { cancelJob, serializeJob } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

/**
 * POST /api/bulk/:id/cancel
 *
 * Stops a background job between chunks. What it already did stays done;
 * what it had not reached goes back to the review queues.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  return guard(async () => {
    const job = await cancelJob(params.id);
    if (!job) return fail('No such job.', 404);
    return ok({ job: serializeJob(job) });
  }, 'POST /api/bulk/:id/cancel');
}
