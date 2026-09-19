import { Suspense } from 'react';
import { Bot, Clock3, Coins, Database, KeyRound, Link2 } from 'lucide-react';

import { listAccounts, resolveSelection } from '@/lib/accounts';
import { AccountsPanel } from '@/components/settings/accounts-panel';
import { DangerZone } from '@/components/settings/danger-zone';
import { MailboxSettings } from '@/components/settings/mailbox-settings';
import { ProcessingForm } from '@/components/settings/processing-form';
import { PageHeader, StatCard } from '@/components/stat-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { env, integrationStatus } from '@/lib/env';
import { isDatabaseReachable } from '@/lib/prisma';
import { serializeAccount } from '@/lib/serialize';
import { sessionEmail } from '@/lib/session';
import { getSettings, getSettingsForAccounts } from '@/lib/settings';
import { costSummary } from '@/lib/stats';
import { cn, formatInt, formatUsd } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Settings' };

function IntegrationRow({
  icon: Icon,
  label,
  configured,
  onHint,
  offHint,
}: {
  icon: typeof Bot;
  label: string;
  configured: boolean;
  onHint: string;
  offHint: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <span
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md',
          configured ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          {label}
          <span className={cn('size-1.5 rounded-full', configured ? 'bg-success' : 'bg-muted-foreground/50')} />
        </p>
        <p className="text-xs leading-snug text-muted-foreground">{configured ? onHint : offHint}</p>
      </div>
    </div>
  );
}

export default async function SettingsPage() {
  const accounts = await listAccounts();
  const [settings, perAccount, cost, databaseReachable, loginEmail, selection] = await Promise.all([
    // No account scope: the shared settings.
    getSettings(),
    getSettingsForAccounts(accounts.map((account) => account.id)),
    costSummary(null),
    isDatabaseReachable(),
    sessionEmail(),
    resolveSelection(accounts),
  ]);
  const status = integrationStatus();

  const mailboxes = accounts.map((account) => {
    const scoped = perAccount.get(account.id);
    return {
      id: account.id,
      email: account.email,
      dailyLimit: account.dailyLimit,
      dryRun: scoped?.dryRun ?? settings.dryRun,
      backlogOrder: scoped?.backlogOrder ?? settings.backlogOrder,
      backlogQuery: scoped?.backlogQuery ?? settings.backlogQuery,
    };
  });

  return (
    <>
      <PageHeader title="Settings" description="Mailboxes, processing, learning, model prices and what is configured on the server." />
      <div className="space-y-5">
        <Suspense fallback={null}>
          <AccountsPanel
            accounts={accounts.map(serializeAccount)}
            googleConfigured={status.google}
            encryptionConfigured={status.encryption}
            mockMail={status.mockMail}
            redirectUri={env.googleRedirectUri}
            loginRedirectUri={`${env.appUrl}/api/auth/google/callback`}
            loginEmail={loginEmail}
          />
        </Suspense>

        <MailboxSettings
          mailboxes={mailboxes}
          defaultId={selection.selected?.id ?? null}
          defaultDailyLimit={settings.dailyLimit}
        />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Spend</CardTitle>
            <CardDescription className="mt-1">
              From the token counts Gemini reports on every call, at the prices below.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Today" value={formatUsd(cost.today)} icon={Coins} />
            <StatCard label="This month" value={formatUsd(cost.month)} icon={Coins} />
            <StatCard label="Lifetime" value={formatUsd(cost.lifetime)} hint={`${formatInt(cost.aiEmailsLifetime)} emails classified by AI`} icon={Coins} />
            <StatCard
              label="Per email (7 days)"
              value={cost.avgPerEmail7d === null ? '—' : formatUsd(cost.avgPerEmail7d)}
              hint={`${formatInt(cost.calls7d)} calls · ${formatInt(cost.tokens7d)} tokens`}
              icon={Clock3}
            />
          </CardContent>
        </Card>

        <ProcessingForm settings={settings} timezone={env.timezone} />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Server configuration</CardTitle>
            <CardDescription className="mt-1">
              Read from <code>.env</code> at startup. Edit the file and recreate the container to change these.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <IntegrationRow icon={Bot} label="Gemini" configured={status.gemini} onHint={`Classifying with ${settings.geminiModel}.`} offHint="Set GEMINI_API_KEY. Until then unmatched emails go to Needs attention." />
            <IntegrationRow icon={Link2} label="Google OAuth" configured={status.google} onHint="Gmail accounts can be connected." offHint="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." />
            <IntegrationRow icon={KeyRound} label="Token encryption" configured={status.encryption} onHint="Mailbox tokens are encrypted at rest." offHint="Set TOKEN_ENCRYPTION_KEY (openssl rand -base64 32)." />
            <IntegrationRow icon={Database} label="SQLite" configured={databaseReachable} onHint="History is being saved." offHint="Run `prisma db push` to create the database." />
            <IntegrationRow icon={Clock3} label="Scheduler" configured={env.schedulerEnabled} onHint={`Runs at ${settings.runTimes || 'no set times'} (${env.timezone}).`} offHint="Disabled; drive runs with cron via /api/jobs/run." />
            <IntegrationRow icon={Coins} label="Cron secret" configured={Boolean(env.cronSecret)} onHint="POST /api/jobs/run is enabled." offHint="Optional. Set CRON_SECRET to trigger runs from cron." />
          </CardContent>
        </Card>

        <DangerZone />
      </div>
    </>
  );
}
