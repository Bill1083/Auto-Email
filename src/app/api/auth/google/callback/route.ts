import { NextResponse } from 'next/server';

import { guard } from '@/lib/api';
import {
  SESSION_COOKIE,
  sessionTtlMs,
  clientIp,
  createSessionToken,
  emailAllowed,
  loginAllowed,
  recordLoginFailure,
  safeNextPath,
  sessionCookieOptions,
} from '@/lib/auth';
import { env } from '@/lib/env';
import {
  LOGIN_STATE_COOKIE,
  LOGIN_VERIFIER_COOKIE,
  exchangeCode,
  readIdToken,
} from '@/lib/mail/gmail/oauth';

export const dynamic = 'force-dynamic';

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header);
  return match ? decodeURIComponent(match[1]) : null;
}

function toLogin(error: string): NextResponse {
  const url = new URL('/login', env.appUrl);
  url.searchParams.set('error', error);
  const response = NextResponse.redirect(url);
  response.cookies.set(LOGIN_STATE_COOKIE, '', { path: '/api/auth/google', maxAge: 0 });
  response.cookies.set(LOGIN_VERIFIER_COOKIE, '', { path: '/api/auth/google', maxAge: 0 });
  return response;
}

/**
 * GET /api/auth/google/callback?code=&state=
 *
 * Completes "Sign in with Google": verifies state and PKCE, reads the ID
 * token, checks the address against DASHBOARD_ALLOWED_EMAILS, and only then
 * issues the session cookie.
 */
export async function GET(request: Request) {
  return guard(async () => {
    if (!env.googleLoginEnabled || !env.sessionSecret) {
      return toLogin('Google sign-in is not configured on the server.');
    }
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const denied = url.searchParams.get('error');
    if (denied) return toLogin(`Google returned "${denied}".`);

    const storedState = cookieValue(request, LOGIN_STATE_COOKIE);
    const verifier = cookieValue(request, LOGIN_VERIFIER_COOKIE);
    if (!code || !state || !storedState || !verifier || storedState !== state) {
      return toLogin('The sign-in state did not match. Start again.');
    }

    const ip = clientIp(request);
    if (!loginAllowed(ip)) return toLogin('Too many attempts. Try again in 15 minutes.');

    let claims;
    try {
      const tokens = await exchangeCode(code, verifier, `${env.appUrl}/api/auth/google/callback`);
      if (!tokens.idToken) return toLogin('Google did not return an identity token.');
      claims = readIdToken(tokens.idToken, env.googleClientId as string);
    } catch (error) {
      recordLoginFailure(ip);
      return toLogin(error instanceof Error ? error.message : 'Sign-in failed.');
    }

    if (!claims.emailVerified) {
      recordLoginFailure(ip);
      return toLogin('Google reports that address as unverified.');
    }
    if (!emailAllowed(claims.email, env.dashboardAllowedEmails)) {
      recordLoginFailure(ip);
      console.warn(`[automail] sign-in refused for ${claims.email} (not on DASHBOARD_ALLOWED_EMAILS)`);
      return toLogin(`${claims.email} is not allowed to use this dashboard.`);
    }

    const nextEncoded = state.split('.')[1] ?? '';
    const next = safeNextPath(nextEncoded ? Buffer.from(nextEncoded, 'base64url').toString('utf8') : '/');

    const token = await createSessionToken(env.sessionSecret, `google:${claims.email}`);
    const response = NextResponse.redirect(new URL(next, env.appUrl));
    response.cookies.set(SESSION_COOKIE, token, {
      ...sessionCookieOptions(env.appUrl.startsWith('https://')),
      maxAge: Math.floor(sessionTtlMs() / 1000),
    });
    response.cookies.set(LOGIN_STATE_COOKIE, '', { path: '/api/auth/google', maxAge: 0 });
    response.cookies.set(LOGIN_VERIFIER_COOKIE, '', { path: '/api/auth/google', maxAge: 0 });
    return response;
  }, 'GET /api/auth/google/callback');
}
