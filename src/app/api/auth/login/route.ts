import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import {
  SESSION_COOKIE,
  sessionTtlMs,
  clearLoginFailures,
  clientIp,
  createSessionToken,
  loginAllowed,
  recordLoginFailure,
  sessionCookieOptions,
  verifyPassword,
} from '@/lib/auth';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  password: z.string().min(1).max(512),
});

/**
 * POST /api/auth/login — the optional password fallback. Disabled entirely
 * when DASHBOARD_PASSWORD is empty, which is the recommended production
 * setup once Google sign-in works.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const expected = env.dashboardPassword;
    const secret = env.sessionSecret;
    if (!secret) {
      return fail('The dashboard is locked: set SESSION_SECRET in .env and restart.', 503);
    }
    if (!expected) {
      return fail('Password sign-in is disabled. Use Sign in with Google.', 403);
    }

    const ip = clientIp(request);
    if (!loginAllowed(ip)) {
      return fail('Too many attempts. Try again in 15 minutes.', 429);
    }

    const parsed = await readJson(request, bodySchema, 64 * 1024);
    if (!parsed.ok) return parsed.response;

    if (!(await verifyPassword(parsed.data.password, expected))) {
      recordLoginFailure(ip);
      return fail('Wrong password.', 401);
    }
    clearLoginFailures(ip);

    const token = await createSessionToken(secret, 'password');
    const response = ok({ ok: true });
    response.cookies.set(SESSION_COOKIE, token, {
      ...sessionCookieOptions(env.appUrl.startsWith('https://')),
      maxAge: Math.floor(sessionTtlMs() / 1000),
    });
    return response;
  }, 'POST /api/auth/login');
}
