/**
 * The current dashboard session, for server components and route handlers.
 */

import { cookies } from 'next/headers';

import { SESSION_COOKIE, verifySessionToken, type Session } from '@/lib/auth';
import { env } from '@/lib/env';

export async function getSession(): Promise<Session | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  return verifySessionToken(env.sessionSecret, token);
}

/** The Google address the user signed in with, or null for password sign-in. */
export async function sessionEmail(): Promise<string | null> {
  const session = await getSession();
  if (!session || !session.identity.startsWith('google:')) return null;
  return session.identity.slice('google:'.length);
}
