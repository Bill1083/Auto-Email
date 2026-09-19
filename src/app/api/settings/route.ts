import { getAccount, listAccounts, resolveSelection } from '@/lib/accounts';
import { fail, guard, ok, readJson } from '@/lib/api';
import { env, integrationStatus } from '@/lib/env';
import { prisma, withDatabase } from '@/lib/prisma';
import {
  PER_ACCOUNT_KEYS,
  SettingsScopeError,
  getSettings,
  settingsPatchSchema,
  updateSettings,
} from '@/lib/settings';
import { costSummary } from '@/lib/stats';

export const dynamic = 'force-dynamic';

/**
 * Which mailbox the request is about. `?accountId=` wins; otherwise the
 * dashboard's selected mailbox is used, and "all accounts" means no scope
 * (global settings only).
 */
async function scopeFor(request: Request): Promise<{ accountId: string | null; known: boolean }> {
  const raw = new URL(request.url).searchParams.get('accountId');
  if (raw === 'all') return { accountId: null, known: true };
  if (raw) return { accountId: raw, known: Boolean(await getAccount(raw)) };
  const { selected } = await resolveSelection(await listAccounts());
  return { accountId: selected?.id ?? null, known: true };
}

/**
 * GET /api/settings?accountId=
 *
 * Settings as they apply to that mailbox, plus which keys are per-mailbox so
 * the UI knows what it is editing.
 */
export async function GET(request: Request) {
  return guard(async () => {
    const { accountId, known } = await scopeFor(request);
    if (!known) return fail('No such account.', 404);

    const [settings, cost] = await Promise.all([getSettings(accountId), costSummary(null)]);
    return ok({
      settings,
      accountId,
      perAccountKeys: PER_ACCOUNT_KEYS,
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
 * Shared keys are written globally; the per-mailbox keys (profile, learned
 * notes, dry run, backlog scope) are written against the named mailbox and
 * refused without one, so they can never leak across mailboxes.
 */
export async function PATCH(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, settingsPatchSchema, 64 * 1024);
    if (!parsed.ok) return parsed.response;

    const { accountId, known } = await scopeFor(request);
    if (!known) return fail('No such account.', 404);

    const before = await getSettings(accountId);
    let settings;
    try {
      settings = await updateSettings(parsed.data, accountId);
    } catch (error) {
      if (error instanceof SettingsScopeError) {
        return fail(
          `${error.message} Connect a mailbox and choose it before changing this setting.`,
          422,
        );
      }
      throw error;
    }

    // A new prefix means new labels: forget the cached ids so the next run
    // creates AutoMail-new/... labels. The old ones stay in Gmail untouched.
    if (parsed.data.labelPrefix && parsed.data.labelPrefix !== before.labelPrefix) {
      await withDatabase(() =>
        prisma.account.updateMany({
          data: { labelMapJson: '{}', labelPrefix: settings.labelPrefix },
        }),
      );
    }
    return ok({ settings, accountId });
  }, 'PATCH /api/settings');
}
