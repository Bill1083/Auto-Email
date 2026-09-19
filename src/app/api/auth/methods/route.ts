import { ok } from '@/lib/api';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** GET /api/auth/methods — which sign-in methods the login page should offer. */
export async function GET() {
  return ok({
    google: env.googleLoginEnabled,
    password: env.passwordLoginEnabled,
    sessionConfigured: Boolean(env.sessionSecret),
  });
}
