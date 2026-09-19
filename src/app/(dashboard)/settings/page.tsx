import { Suspense } from 'react';
import { Bot, Clock3, Coins, Database, KeyRound, Link2 } from 'lucide-react';

import { listAccounts, resolveSelection } from '@/lib/accounts';
import { AccountsPanel } from '@/components/settings/accounts-panel';
import { DangerZone } from '@/components/settings/danger-zone';
import { SettingsForm } from '@/components/settings/settings-form';
import { ChooseMailbox } from '@/components/shared/choose-mailbox';
import { PageHeader, StatCard } from '@/components/stat-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { env, integrationStatus } from '@/lib/env';
import { isDatabaseReachable } from '@/lib/prisma';
import { serializeAccount } from '@/lib/serialize';
import { sessionEmail } from '@/lib/session';
import { getSettings } from '@/lib/settings';
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
  // Everything on this page follows the mailbox chosen in the top right.
  const { selected } = await resolveSelection(accounts);
  const [settings, cost, databaseReachable, loginEmail] = await Promise.all([
    getSettings(selected?.id ?? null),
    costSummary(selected?.id ?? null),
    isDatabaseReachable(),
    sessionEmail(),
  ]);
  const status = integrationStatus();
  const shown = selected ? [selected] : accounts;
  const loginMailboxConnected =
    loginEmail !== null && accounts.some((a) => a.email.toLowerCase() === loginEmail.toLowerCase());

  return (
    <>
      <PageHeader
        title="Settings"
        description={
          selected
            ? `Settings for ${selected.email}. Switch mailbox in the top right to see another's.`
            : 'Viewing all accounts. Choose a mailbox in the top right to see and change its settings.'
        }
      />
      <div className="space-y-5">
        <Suspense fallback={null}>
          <AccountsPanel
            accounts={shown.map(serializeAccount)}
            scoped={Boolean(selected)}
            googleConfigured={status.google}
            encryptionConfigured={status.encryption}
            mockMail={status.mockMail}
            redirectUri={env.googleRedirectUri}
            loginRedirectUri={`${env.appUrl}/api/auth/google/callback`}
            loginEmail={loginEmail}
            loginMailboxConnected={loginMailboxConnected}
          />
        </Suspense>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Spend</CardTitle>
            <CardDescription className="mt-1">
              {selected ? `What ${selected.email} has cost` : 'What every mailbox has cost together'}, from
              the token counts Gemini reports on every call.
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

        {selected ? (
          <SettingsForm key={selected.id} accountId={selected.id} email={selected.email} settings={settings} timezone={env.timezone} />
        ) : (
          <ChooseMailbox title="Mailbox settings" what="settings" hasMailboxes={accounts.length > 0} />
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Server configuration</CardTitle>
            <CardDescription className="mt-1">
              Read from <code>.env</code> at startup and shared by the whole server. Edit the file and recreate the
              container to change these.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <IntegrationRow icon={Bot} label="Gemini" configured={status.gemini} onHint="API key set; each mailbox picks its own model above." offHint="Set GEMINI_API_KEY. Until then unmatched emails go to Needs attention." />
            <IntegrationRow icon={Link2} label="Google OAuth" configured={status.google} onHint="Gmail accounts can be connected." offHint="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." />
            <IntegrationRow icon={KeyRound} label="Token encryption" configured={status.encryption} onHint="Mailbox tokens are encrypted at rest." offHint="Set TOKEN_ENCRYPTION_KEY (openssl rand -base64 32)." />
            <IntegrationRow icon={Database} label="SQLite" configured={databaseReachable} onHint="History is being saved." offHint="Run `prisma db push` to create the database." />
            <IntegrationRow icon={Clock3} label="Scheduler" configured={env.schedulerEnabled} onHint={`Each mailbox runs at its own times (${env.timezone}).`} offHint="Disabled; drive runs with cron via /api/jobs/run." />
            <IntegrationRow icon={Coins} label="Cron secret" configured={Boolean(env.cronSecret)} onHint="POST /api/jobs/run is enabled." offHint="Optional. Set CRON_SECRET to trigger runs from cron." />
          </CardContent>
        </Card>

        <DangerZone accountId={selected?.id ?? null} email={selected?.email ?? null} />
      </div>
    </>
  );
}
