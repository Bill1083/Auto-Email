import { NextResponse } from 'next/server';

import { guard } from '@/lib/api';
import { encryptSecret } from '@/lib/crypto';
import { env } from '@/lib/env';
import { GmailClient } from '@/lib/mail/gmail/client';
import {
  GMAIL_SCOPE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  exchangeCode,
} from '@/lib/mail/gmail/oauth';
import { prisma, withDatabase } from '@/lib/prisma';
import { ACCOUNT_COOKIE } from '@/lib/accounts';

export const dynamic = 'force-dynamic';

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header);
  return match ? decodeURIComponent(match[1]) : null;
}

function settingsRedirect(params: Record<string, string>): NextResponse {
  const url = new URL('/settings', env.appUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_STATE_COOKIE, '', { path: '/api/google', maxAge: 0 });
  response.cookies.set(OAUTH_VERIFIER_COOKIE, '', { path: '/api/google', maxAge: 0 });
  return response;
}

/**
 * GET /api/google/callback?code=&state=
 *
 * Exchanges the code, reads the mailbox address, and creates or reconnects
 * the account. Tokens are encrypted before they are stored.
 */
export async function GET(request: Request) {
  return guard(async () => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const denied = url.searchParams.get('error');

    if (denied) return settingsRedirect({ error: `Google returned "${denied}".` });

    const storedState = cookieValue(request, OAUTH_STATE_COOKIE);
    const verifier = cookieValue(request, OAUTH_VERIFIER_COOKIE);
    if (!code || !state || !storedState || !verifier || storedState !== state) {
      return settingsRedirect({ error: 'The connection state did not match. Start the connection again.' });
    }

    let tokens;
    try {
      tokens = await exchangeCode(code, verifier, env.googleRedirectUri);
    } catch (error) {
      return settingsRedirect({
        error: error instanceof Error ? error.message : 'Token exchange failed.',
      });
    }

    if (!tokens.scope.split(/\s+/).includes(GMAIL_SCOPE)) {
      return settingsRedirect({
        error: 'Mailbox access was not granted. Tick the Gmail permission on the consent screen and try again.',
      });
    }
    if (!tokens.refreshToken) {
      return settingsRedirect({
        error:
          'Google did not return a refresh token. Remove AutoMail from your Google account permissions (myaccount.google.com/permissions) and connect again.',
      });
    }

    let email: string;
    try {
      const client = new GmailClient({ getAccessToken: async () => tokens.accessToken });
      email = (await client.profile()).email;
    } catch (error) {
      return settingsRedirect({
        error: `Connected to Google but could not read the mailbox profile: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }

    const now = new Date();
    const refreshTokenEnc = await encryptSecret(tokens.refreshToken);
    const accessTokenEnc = await encryptSecret(tokens.accessToken);
    const saved = await withDatabase(() =>
      prisma.account.upsert({
        where: { email },
        create: {
          provider: 'gmail',
          email,
          refreshTokenEnc,
          accessTokenEnc,
          accessTokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scope,
          status: 'ACTIVE',
          // Mail from this moment on is "new"; everything before is backlog.
          lastSyncAt: now,
        },
        update: {
          refreshTokenEnc,
          accessTokenEnc,
          accessTokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scope,
          status: 'ACTIVE',
          lastError: null,
        },
      }),
    );
    if (!saved.ok) {
      return settingsRedirect({ error: 'Google accepted the connection but the database write failed.' });
    }

    const response = settingsRedirect({ connected: email });
    response.cookies.set(ACCOUNT_COOKIE, saved.data.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.appUrl.startsWith('https://'),
      path: '/',
      maxAge: 365 * 86_400,
    });
    return response;
  }, 'GET /api/google/callback');
}
