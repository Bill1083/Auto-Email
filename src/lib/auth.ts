/**
 * Dashboard sessions.
 *
 * Two ways in, both ending in the same signed cookie:
 *   - Sign in with Google: the Google identity must be on DASHBOARD_ALLOWED_EMAILS.
 *   - Password: only if DASHBOARD_PASSWORD is set (optional fallback).
 *
 * The cookie is `<expiry>.<identity>.<hmac>`; the middleware verifies the
 * HMAC on every request. Everything here uses Web Crypto only, so the same
 * code runs in the Edge middleware and in Node route handlers.
 */

import { env } from '@/lib/env';

export const SESSION_COOKIE = 'automail_session';

/** Session lifetime from SESSION_TTL_DAYS (default 30 days). */
export function sessionTtlMs(): number {
  return env.sessionTtlDays * 24 * 60 * 60 * 1000;
}

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64Url(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  try {
    const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function sign(secret: string, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return toHex(signature);
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface Session {
  /** `google:<email>` or `password`. */
  identity: string;
  expiresAt: number;
}

export async function createSessionToken(
  secret: string,
  identity: string,
  ttlMs = sessionTtlMs(),
): Promise<string> {
  const expires = String(Date.now() + ttlMs);
  const encodedIdentity = toBase64Url(identity);
  const signature = await sign(secret, `${expires}.${encodedIdentity}`);
  return `${expires}.${encodedIdentity}.${signature}`;
}

export async function verifySessionToken(
  secret: string | undefined,
  token: string | undefined,
): Promise<Session | null> {
  if (!secret || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [expires, encodedIdentity, signature] = parts;
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return null;
  const expected = await sign(secret, `${expires}.${encodedIdentity}`);
  if (!safeEqual(expected, signature)) return null;
  const identity = fromBase64Url(encodedIdentity);
  if (!identity) return null;
  return { identity, expiresAt: Number(expires) };
}

/** Human-readable label for the header. */
export function describeIdentity(identity: string): string {
  if (identity.startsWith('google:')) return identity.slice('google:'.length);
  return 'password sign-in';
}

/**
 * Compare a submitted password against the configured one without leaking
 * its length through timing: both sides are hashed first.
 */
export async function verifyPassword(candidate: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return safeEqual(toHex(a), toHex(b));
}

/** Case-insensitive allowlist membership. */
export function emailAllowed(email: string, allowlist: string[]): boolean {
  const needle = email.trim().toLowerCase();
  return needle.length > 0 && allowlist.some((entry) => entry.trim().toLowerCase() === needle);
}

// ---------------------------------------------------------------------------
// Login attempt limiter (in-process; Nginx adds a second layer in production)
// ---------------------------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, { count: number; resetAt: number }>();

export function loginAllowed(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) return true;
  return entry.count < MAX_ATTEMPTS;
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export function clearLoginFailures(ip: string): void {
  attempts.delete(ip);
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'local';
}

/** Cookie attributes shared by every session-setting route. */
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
  };
}

/** Only same-origin relative paths are accepted as a post-login destination. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value;
}
