import { z } from 'zod';

import { fail, guard, ok } from '@/lib/api';
import { safeEqual } from '@/lib/auth';
import { env } from '@/lib/env';
import { runAllAccounts } from '@/lib/pipeline/run';

export const dynamic = 'force-dynamic';
// A full run across several accounts can take a few minutes.
export const maxDuration = 300;

const laneSchema = z.enum(['new', 'backlog', 'both']);

/**
 * POST /api/jobs/run?lane=both
 * Authorization: Bearer <CRON_SECRET>
 *
 * The cron entry point. Runs every active account and waits for the result so
 * the caller's log shows what happened. Call it on 127.0.0.1:3000 directly
 * rather than through Nginx to avoid the proxy timeout.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const secret = env.cronSecret;
    if (!secret) return fail('CRON_SECRET is not configured.', 503);
    const header = request.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !safeEqual(token, secret)) return fail('Unauthorised.', 401);

    const laneRaw = new URL(request.url).searchParams.get('lane') ?? 'both';
    const lane = laneSchema.safeParse(laneRaw);
    if (!lane.success) return fail('lane must be new, backlog or both.', 422);

    const outcomes = await runAllAccounts('cron', lane.data);
    return ok({ outcomes });
  }, 'POST /api/jobs/run');
}
