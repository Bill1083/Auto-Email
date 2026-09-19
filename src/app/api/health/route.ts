import { ok } from '@/lib/api';
import { integrationStatus } from '@/lib/env';
import { isDatabaseReachable } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * Liveness and configuration probe. Used by the Docker health check; it
 * reveals only whether each integration is configured, never the values.
 */
export async function GET() {
  const configured = integrationStatus();
  const databaseReachable = await isDatabaseReachable();

  return ok({
    status: 'ok',
    time: new Date().toISOString(),
    integrations: {
      gemini: configured.gemini ? 'configured' : 'missing-key',
      google: configured.google ? 'configured' : 'missing-client',
      encryption: configured.encryption ? 'configured' : 'missing-key',
      password: configured.password ? 'configured' : 'missing',
      mockMail: configured.mockMail ? 'on' : 'off',
      database: databaseReachable
        ? 'reachable'
        : configured.database
          ? 'unreachable'
          : 'not-configured',
    },
  });
}
