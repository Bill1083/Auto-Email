import { getAccount, listAccounts, resolveSelection } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { env, integrationStatus } from '@/lib/env';
import {
  SettingsScopeError,
  getSettings,
  settingsPatchSchema,
  updateSettings,
} from '@/lib/settings';
import { costSummary } from '@/lib/stats';

export const dynamic = 'force-dynamic';

/**
 * The mailbox a request is about: `?accountId=` if given, otherwise the
 * mailbox chosen in the top-right switcher. "All accounts" means none.
 */
async function mailboxFor(request: Request): Promise<{ accountId: string | null; known: boolean }> {
  const raw = new URL(request.url).searchParams.get('accountId');
  if (raw === 'all') return { accountId: null, known: true };
  if (raw) return { accountId: raw, known: Boolean(await getAccount(raw)) };
  const { selected } = await resolveSelection(await listAccounts());
  return { accountId: selected?.id ?? null, known: true };
}

/**
 * GET /api/settings?accountId=
 *
 * That mailbox's settings. Without one, the `.env` defaults a new mailbox
 * would start from.
 */
export async function GET(request: Request) {
  return guard(async () => {
    const { accountId, known } = await mailboxFor(request);
    if (!known) return fail('No such account.', 404);

    const [settings, cost] = await Promise.all([getSettings(accountId), costSummary(accountId)]);
    return ok({
      settings,
      accountId,
      integrations: integrationStatus(),
      timezone: env.timezone,
      appUrl: env.appUrl,
      redirectUri: env.googleRedirectUri,
      cost,
    });
  }, 'GET /api/settings');
}

/**
 * PATCH /api/settings?accountId=
 *
 * Writes to one mailbox only. Refused on "All accounts" rather than guessing
 * which mailbox was meant.
 */
export async function PATCH(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, settingsPatchSchema, 64 * 1024);
    if (!parsed.ok) return parsed.response;

    const { accountId, known } = await mailboxFor(request);
    if (!known) return fail('No such account.', 404);

    try {
      // A changed label prefix is picked up by that mailbox's next run, which
      // creates the new labels; the old ones stay in Gmail untouched.
      const settings = await updateSettings(parsed.data, accountId);
      return ok({ settings, accountId });
    } catch (error) {
      if (error instanceof SettingsScopeError) return fail(error.message, 422);
      throw error;
    }
  }, 'PATCH /api/settings');
}
