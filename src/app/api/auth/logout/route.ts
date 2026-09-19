import { ok } from '@/lib/api';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** POST /api/auth/logout — clear the session cookie. */
export async function POST() {
  const response = ok({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', {
    ...sessionCookieOptions(env.appUrl.startsWith('https://')),
    maxAge: 0,
  });
  return response;
}
