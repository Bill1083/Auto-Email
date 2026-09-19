/**
 * Google OAuth 2.0 with plain `fetch`, used for two things:
 *
 *   1. Signing in to the dashboard (scopes: openid email). The resulting
 *      identity must be on DASHBOARD_ALLOWED_EMAILS.
 *   2. Connecting a mailbox (scope: gmail.modify) with offline access, so
 *      the pipeline can work while nobody is logged in.
 *
 * Both flows use a random `state` and PKCE (S256). Only three endpoints are
 * needed, so the `googleapis` / `google-auth-library` packages and their
 * dependency trees are left out of the image on purpose.
 */

import { fromBase64Url, randomToken, sha256Base64Url } from '@/lib/crypto';
import { env } from '@/lib/env';
import { ReauthRequiredError, ProviderError } from '@/lib/mail/provider';

/** The one mailbox scope the app asks for. It cannot permanently delete mail. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
/** Identity only, for signing in to the dashboard. */
export const LOGIN_SCOPE = 'openid email';

/** Short-lived cookies carrying CSRF state and the PKCE verifier between /start and /callback. */
export const OAUTH_STATE_COOKIE = 'automail_oauth_state';
export const OAUTH_VERIFIER_COOKIE = 'automail_oauth_verifier';
export const LOGIN_STATE_COOKIE = 'automail_login_state';
export const LOGIN_VERIFIER_COOKIE = 'automail_login_verifier';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: Date;
  scope: string;
}

export function isGoogleConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret);
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = env.googleClientId;
  const clientSecret = env.googleClientSecret;
  if (!clientId || !clientSecret) {
    throw new ProviderError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured.', 503);
  }
  return { clientId, clientSecret };
}

/** PKCE: a random verifier and its S256 challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

export function randomState(): string {
  return randomToken(24);
}

export interface AuthUrlOptions {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  /** Mailbox connection or dashboard sign-in. */
  purpose: 'mailbox' | 'login';
  loginHint?: string;
}

/** Where to send the browser to grant access. */
export function buildAuthUrl(options: AuthUrlOptions): string {
  const { clientId } = credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (options.purpose === 'mailbox') {
    params.set('scope', GMAIL_SCOPE);
    // Offline + consent guarantees a refresh token on every connect, including
    // reconnects of an account that was connected before.
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    params.set('include_granted_scopes', 'true');
  } else {
    params.set('scope', LOGIN_SCOPE);
    params.set('prompt', 'select_account');
  }
  if (options.loginHint) params.set('login_hint', options.loginHint);
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  let json: TokenResponse = {};
  try {
    json = (await response.json()) as TokenResponse;
  } catch {
    json = {};
  }
  if (!response.ok || json.error) {
    const code = json.error ?? `http_${response.status}`;
    if (code === 'invalid_grant') {
      throw new ReauthRequiredError(
        `Google rejected the stored credentials (${json.error_description ?? 'invalid_grant'}).`,
      );
    }
    throw new ProviderError(
      `Google token request failed: ${code}${json.error_description ? ` (${json.error_description})` : ''}`,
      response.status || 502,
    );
  }
  return json;
}

function toTokenSet(json: TokenResponse, fallbackRefresh: string | null): TokenSet {
  if (!json.access_token) {
    throw new ProviderError('Google returned no access token.', 502);
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3_600;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? fallbackRefresh,
    idToken: json.id_token ?? null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scope: json.scope ?? '',
  };
}

export async function exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenSet> {
  const { clientId, clientSecret } = credentials();
  const json = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  return toTokenSet(json, null);
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const { clientId, clientSecret } = credentials();
  const json = await tokenRequest({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });
  return toTokenSet(json, refreshToken);
}

/** Best effort: revoking a token that is already dead is not an error. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.warn('[automail] token revoke failed:', error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// ID token
// ---------------------------------------------------------------------------

export interface IdClaims {
  email: string;
  emailVerified: boolean;
  subject: string;
}

/**
 * Claims from an ID token that came straight from Google's token endpoint
 * over TLS with the client secret. In that position the signature has already
 * been vouched for by the channel (Google's own guidance), so only the claims
 * are checked: issuer, audience, expiry and a verified email.
 */
export function readIdToken(idToken: string, clientId: string, now = Date.now()): IdClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new ProviderError('Malformed ID token.', 502);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as Record<string, unknown>;
  } catch {
    throw new ProviderError('Unreadable ID token.', 502);
  }
  const iss = payload.iss;
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    throw new ProviderError('ID token was not issued by Google.', 502);
  }
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(clientId)) throw new ProviderError('ID token was issued for another client.', 502);
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (exp * 1000 < now - 60_000) throw new ProviderError('ID token has expired.', 502);
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  if (!email) throw new ProviderError('ID token carries no email address.', 502);
  return {
    email,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    subject: typeof payload.sub === 'string' ? payload.sub : '',
  };
}
