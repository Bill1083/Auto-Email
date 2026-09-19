import { NextResponse } from 'next/server';

import { fail, guard } from '@/lib/api';
import { safeNextPath } from '@/lib/auth';
import { env } from '@/lib/env';
import {
  LOGIN_STATE_COOKIE,
  LOGIN_VERIFIER_COOKIE,
  buildAuthUrl,
  createPkce,
  randomState,
} from '@/lib/mail/gmail/oauth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/google/start?next=/review
 *
 * Begins "Sign in with Google" for the dashboard itself. Identity only: the
 * request asks for `openid email`, never for mailbox access.
 */
export async function GET(request: Request) {
  return guard(async () => {
    if (!env.googleLoginEnabled) {
      return fail(
        'Google sign-in is not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and DASHBOARD_ALLOWED_EMAILS.',
        503,
      );
    }
    const next = safeNextPath(new URL(request.url).searchParams.get('next'));
    const state = `${randomState()}.${Buffer.from(next, 'utf8').toString('base64url')}`;
    const pkce = await createPkce();
    const secure = env.appUrl.startsWith('https://');

    const response = NextResponse.redirect(
      buildAuthUrl({
        state,
        codeChallenge: pkce.challenge,
        redirectUri: `${env.appUrl}/api/auth/google/callback`,
        purpose: 'login',
      }),
    );
    const cookie = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/api/auth/google', maxAge: 600 };
    response.cookies.set(LOGIN_STATE_COOKIE, state, cookie);
    response.cookies.set(LOGIN_VERIFIER_COOKIE, pkce.verifier, cookie);
    return response;
  }, 'GET /api/auth/google/start');
}
