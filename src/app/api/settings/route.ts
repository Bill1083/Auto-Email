import { fail, guard, ok, readJson } from '@/lib/api';
import { env, integrationStatus } from '@/lib/env';
import { prisma, withDatabase } from '@/lib/prisma';
import { getSettings, settingsPatchSchema, updateSettings } from '@/lib/settings';
import { costSummary } from '@/lib/stats';

export const dynamic = 'force-dynamic';

/** GET /api/settings — current settings, which integrations are configured, spend. */
export async function GET() {
  return guard(async () => {
    const [settings, cost] = await Promise.all([getSettings(), costSummary(null)]);
    return ok({
      settings,
      integrations: integrationStatus(),
      timezone: env.timezone,
      appUrl: env.appUrl,
      redirectUri: env.googleRedirectUri,
      cost,
    });
  }, 'GET /api/settings');
}

/** PATCH /api/settings — any subset of the editable settings. */
export async function PATCH(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, settingsPatchSchema, 64 * 1024);
    if (!parsed.ok) return parsed.response;

    const before = await getSettings();
    const settings = await updateSettings(parsed.data);

    // A new prefix means new labels: forget the cached ids so the next run
    // creates AutoMail-new/... labels. The old ones stay in Gmail untouched.
    if (parsed.data.labelPrefix && parsed.data.labelPrefix !== before.labelPrefix) {
      await withDatabase(() =>
        prisma.account.updateMany({
          data: { labelMapJson: '{}', labelPrefix: settings.labelPrefix },
        }),
      );
    }
    return ok({ settings });
  }, 'PATCH /api/settings');
}
