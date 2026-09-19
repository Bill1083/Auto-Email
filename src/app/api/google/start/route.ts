import { NextResponse } from 'next/server';

import { fail, guard } from '@/lib/api';
import { env } from '@/lib/env';
import { isEncryptionConfigured } from '@/lib/crypto';
import {
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  buildAuthUrl,
  createPkce,
  isGoogleConfigured,
  randomState,
} from '@/lib/mail/gmail/oauth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/google/start?hint=<email>
 *
 * Sends the (already signed-in) user to Google's consent screen to connect a
 * mailbox. The random state and PKCE verifier live in short-lived cookies
 * and are checked by the callback.
 */
export async function GET(request: Request) {
  return guard(async () => {
    if (!isGoogleConfigured()) {
      return fail('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.', 503);
    }
    if (!isEncryptionConfigured()) {
      return fail('Set TOKEN_ENCRYPTION_KEY in .env first; tokens are never stored in the clear.', 503);
    }

    const url = new URL(request.url);
    const hint = url.searchParams.get('hint') ?? undefined;
    const state = randomState();
    const pkce = await createPkce();
    const secure = env.appUrl.startsWith('https://');

    const response = NextResponse.redirect(
      buildAuthUrl({
        state,
        codeChallenge: pkce.challenge,
        redirectUri: env.googleRedirectUri,
        purpose: 'mailbox',
        loginHint: hint,
      }),
    );
    const cookie = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/api/google', maxAge: 600 };
    response.cookies.set(OAUTH_STATE_COOKIE, state, cookie);
    response.cookies.set(OAUTH_VERIFIER_COOKIE, pkce.verifier, cookie);
    return response;
  }, 'GET /api/google/start');
}
