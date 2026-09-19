import { describe, expect, it } from 'vitest';

import {
  createSessionToken,
  describeIdentity,
  emailAllowed,
  safeEqual,
  safeNextPath,
  verifyPassword,
  verifySessionToken,
} from '@/lib/auth';

const SECRET = 'test-secret-value';

describe('session tokens', () => {
  it('round-trips the identity', async () => {
    const token = await createSessionToken(SECRET, 'google:you@example.com');
    const session = await verifySessionToken(SECRET, token);
    expect(session?.identity).toBe('google:you@example.com');
    expect(session?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects the wrong secret, a tampered identity and expiry', async () => {
    const token = await createSessionToken(SECRET, 'password');
    expect(await verifySessionToken('other-secret', token)).toBeNull();

    const [expires, , signature] = token.split('.');
    const forged = `${expires}.${Buffer.from('google:attacker@example.com').toString('base64url')}.${signature}`;
    expect(await verifySessionToken(SECRET, forged)).toBeNull();

    const expired = await createSessionToken(SECRET, 'password', -1_000);
    expect(await verifySessionToken(SECRET, expired)).toBeNull();
  });

  it('rejects malformed input', async () => {
    expect(await verifySessionToken(SECRET, undefined)).toBeNull();
    expect(await verifySessionToken(undefined, 'a.b.c')).toBeNull();
    expect(await verifySessionToken(SECRET, 'not-a-token')).toBeNull();
  });

  it('describes identities for the header', () => {
    expect(describeIdentity('google:you@example.com')).toBe('you@example.com');
    expect(describeIdentity('password')).toBe('password sign-in');
  });
});

describe('helpers', () => {
  it('compares strings in constant time semantics', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });

  it('verifies passwords', async () => {
    expect(await verifyPassword('hunter2', 'hunter2')).toBe(true);
    expect(await verifyPassword('hunter2', 'hunter3')).toBe(false);
  });

  it('checks the allowlist case-insensitively', () => {
    expect(emailAllowed('You@Example.com', ['you@example.com'])).toBe(true);
    expect(emailAllowed('someone@example.com', ['you@example.com'])).toBe(false);
    expect(emailAllowed('', ['you@example.com'])).toBe(false);
  });

  it('only accepts same-origin relative redirect targets', () => {
    expect(safeNextPath('/review?tab=attention')).toBe('/review?tab=attention');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
  });
});
