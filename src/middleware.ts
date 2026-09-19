import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth';
import { env } from '@/lib/env';

/** Routes reachable without a session. Everything else needs the cookie. */
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/methods',
  '/api/auth/google/start',
  '/api/auth/google/callback',
  '/api/health',
  '/api/jobs/run',
  '/robots.txt',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Every state change comes from this app's own pages as a fetch() call.
  // A browser that says the request is cross-site is not one of those.
  if (!SAFE_METHODS.has(request.method) && pathname !== '/api/jobs/run') {
    const site = request.headers.get('sec-fetch-site');
    if (site === 'cross-site') {
      return NextResponse.json({ error: 'Cross-site requests are not accepted.' }, { status: 403 });
    }
  }

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(env.sessionSecret, token);
  if (session) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (pathname !== '/') url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
