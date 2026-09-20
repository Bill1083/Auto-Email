import Link from 'next/link';
import {
  ArrowRight,
  CalendarClock,
  CircleDollarSign,
  Inbox,
  Layers,
  ListChecks,
  Mail,
  TriangleAlert,
  Wallet,
} from 'lucide-react';

import { listAccounts, resolveSelection } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { ActivityChart } from '@/components/overview/activity-chart';
import { LiveProvider, LiveStatCard, RunProgress } from '@/components/overview/live-status';
import { SetupChecklist } from '@/components/overview/setup-checklist';
import type { LiveResponse } from '@/app/api/live/route';
import { ActionBadge, CategoryBadge, ConfidenceMeter, DecidedByBadge } from '@/components/shared/badges';
import { EmptyState } from '@/components/shared/empty-state';
import { RunNowButton } from '@/components/shared/run-now-button';
import { PageHeader, StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { env, integrationStatus } from '@/lib/env';
import { isRunning } from '@/lib/pipeline/run';
import { prisma, withDatabase } from '@/lib/prisma';
import { getSettingsForAccounts } from '@/lib/settings';
import { overviewStats } from '@/lib/stats';
import { formatDateTime, formatRelative } from '@/lib/time';
import { cn, formatInt, formatUsd, plural } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const accounts = await listAccounts();
  const { selected, selectedId } = await resolveSelection(accounts);
  const scope = selected ? { accountId: selected.id } : {};

  const [perAccount, categories] = await Promise.all([
    getSettingsForAccounts(accounts.map((account) => account.id)),
    listCategories(true),
  ]);
  // The schedule shown is the selected mailbox's own; on "All accounts" each
  // mailbox runs on its own times.
  const settings = selected ? perAccount.get(selected.id) : null;
  const [stats, latest] = await Promise.all([
    overviewStats(selected?.id ?? null, accounts, perAccount),
    withDatabase(() =>
      prisma.message.findMany({ where: scope, orderBy: { processedAt: 'desc' }, take: 8 }),
    ),
  ]);
  const status = integrationStatus();
  const names = Object.fromEntries(categories.map((c) => [c.key, c.name]));
  const emailById = new Map(accounts.map((a) => [a.id, a.email]));
  const running = accounts.some((a) => isRunning(a.id));

  // Seeds the live poller so the tiles and the bar are right on first paint,
  // before the first poll comes back.
  const activeRun =
    stats.lastRun && stats.lastRun.status === 'RUNNING' && isRunning(stats.lastRun.accountId)
      ? stats.lastRun
      : null;
  const initialLive: LiveResponse = {
    run: activeRun
      ? {
          id: activeRun.id,
          accountId: activeRun.accountId,
          accountEmail: emailById.get(activeRun.accountId) ?? '',
          phase: activeRun.phase,
          done: activeRun.progressDone,
          total: activeRun.progressTotal,
          startedAt: activeRun.startedAt.toISOString(),
          dryRun: activeRun.dryRun,
        }
      : null,
    awaitingReview: stats.awaitingReview,
    needsAttention: stats.needsAttention,
    processedToday: stats.processedToday,
    dailyLimit: stats.dailyLimit,
    lastFinished:
      stats.lastRun && stats.lastRun.status !== 'RUNNING'
        ? {
            id: stats.lastRun.id,
            status: stats.lastRun.status,
            error: stats.lastRun.error,
            fetched: stats.lastRun.fetched,
            dryRun: stats.lastRun.dryRun,
          }
        : null,
  };

  const backlogHint =
    stats.backlogRemaining === null
      ? 'Snapshot is taken on the first run'
      : stats.backlogRemaining === 0
        ? 'Backlog cleared'
        : `${stats.backlogDaysToClear ?? '∞'} day${stats.backlogDaysToClear === 1 ? '' : 's'} at the current cap`;

  return (
    // Wraps the header too, so Run now reflects a run started anywhere,
    // including one the scheduler began on its own.
    <LiveProvider accountId={selectedId} initial={initialLive}>
      <PageHeader
        title={selected ? selected.email : 'All mailboxes'}
        description={
          stats.lastRun
            ? `Last run ${formatRelative(stats.lastRun.startedAt)} · next ${
                stats.nextRunAt ? formatDateTime(stats.nextRunAt) : 'not scheduled'
              }${stats.dryRun ? ' · dry run' : ''}`
            : 'No runs yet.'
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/review">
                <ListChecks />
                Review
              </Link>
            </Button>
            <RunNowButton
              accountId={selectedId}
              disabled={accounts.filter((a) => a.status === 'ACTIVE').length === 0}
              initiallyRunning={running}
            />
          </>
        }
      />

      <div className="space-y-5">
        <SetupChecklist
          status={status}
          accountCount={accounts.length}
          dryRunAccounts={stats.dryRunAccounts}
          needsReauth={stats.accountsNeedingReauth}
        />

        {/* Only present while a run is working. */}
        <RunProgress showMailbox={!selected} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <LiveStatCard
            label="Processed today"
            field="processedToday"
            initial={stats.processedToday}
            suffix={` / ${formatInt(stats.dailyLimit)}`}
            hint={stats.processedToday >= stats.dailyLimit && stats.dailyLimit > 0 ? 'Daily cap reached' : 'Daily cap across new mail and backlog'}
            icon="mail"
            tone={stats.processedToday >= stats.dailyLimit && stats.dailyLimit > 0 ? 'muted' : 'default'}
          />
          <LiveStatCard
            label="Awaiting your review"
            field="awaitingReview"
            initial={stats.awaitingReview}
            hint="Proposed deletions to confirm"
            zeroHint="Delete queue is empty"
            icon="review"
            tone="warning"
            zeroTone="muted"
          />
          <LiveStatCard
            label="Needs attention"
            field="needsAttention"
            initial={stats.needsAttention}
            hint="Flagged for you to read or act on"
            zeroHint="Nothing flagged"
            icon="attention"
            tone="danger"
            zeroTone="muted"
          />
          <StatCard
            label="Backlog remaining"
            value={stats.backlogRemaining === null ? '—' : formatInt(stats.backlogRemaining)}
            hint={backlogHint}
            icon={Layers}
          />
          <StatCard
            label="Cost today"
            value={formatUsd(stats.cost.today)}
            hint={`${formatUsd(stats.cost.month)} this month`}
            icon={CircleDollarSign}
          />
          <StatCard
            label="Avg cost per email"
            value={stats.cost.avgPerEmail7d === null ? '—' : formatUsd(stats.cost.avgPerEmail7d)}
            hint={
              stats.cost.avgPerEmail7d === null
                ? 'No AI-classified emails in the last 7 days'
                : `${formatInt(stats.cost.aiEmails7d)} AI-classified in 7 days`
            }
            icon={Wallet}
          />
          <StatCard
            label="Projected backlog cost"
            value={stats.projectedBacklogCost === null ? '—' : formatUsd(stats.projectedBacklogCost)}
            hint={stats.cost.avgPerEmailLifetime === null ? 'Estimated at $0.0004 per email until real data exists' : 'From your observed average'}
            icon={CalendarClock}
          />
          <StatCard
            label="Processed in total"
            value={formatInt(stats.totalProcessed)}
            hint={`${formatInt(stats.totalTrashed)} trashed · ${formatUsd(stats.cost.lifetime)} lifetime`}
            icon={Inbox}
          />
        </div>

        {/* The explicit minmax(0,...) matters on one column too: a bare `1fr`
            floors at min-content, so the chart or a long error line would push
            the whole page wider than a phone screen. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Last 14 days</CardTitle>
              <CardDescription className="mt-1">
                What was done with each day&apos;s email, after your corrections.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ActivityChart series={stats.series} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Mailboxes</CardTitle>
              <CardDescription className="mt-1">Connection health and sync state.</CardDescription>
            </CardHeader>
            <CardContent>
              {accounts.length === 0 ? (
                <EmptyState
                  icon={Mail}
                  title="No mailbox connected"
                  description="Connect a Gmail account, or turn on MOCK_MAIL to explore with the demo mailbox."
                  action={
                    <Button asChild size="sm">
                      <Link href="/settings">Connect a mailbox</Link>
                    </Button>
                  }
                  className="py-6"
                />
              ) : (
                <ul className="space-y-2">
                  {accounts.map((account) => (
                    <li key={account.id} className="rounded-md bg-muted/40 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'size-2 shrink-0 rounded-full',
                            account.status === 'ACTIVE' && 'bg-success',
                            account.status === 'NEEDS_REAUTH' && 'bg-warning',
                            account.status === 'PAUSED' && 'bg-muted-foreground/50',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{account.email}</span>
                        <Badge
                          variant={
                            account.status === 'ACTIVE'
                              ? 'success'
                              : account.status === 'NEEDS_REAUTH'
                                ? 'warning'
                                : 'secondary'
                          }
                        >
                          {account.status === 'ACTIVE'
                            ? 'Active'
                            : account.status === 'NEEDS_REAUTH'
                              ? 'Reconnect'
                              : 'Paused'}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        New mail checked {formatRelative(account.lastNewLaneAt)}
                        {' · '}
                        {account.backlogBuiltAt
                          ? account.backlogDone
                            ? 'backlog done'
                            : `${formatInt(account.backlogEstimate ?? 0)} in backlog`
                          : 'backlog not started'}
                      </p>
                      {account.lastError ? (
                        // Wrapped, not truncated: `truncate` sets white-space
                        // nowrap, and a long provider error then sets the
                        // column's minimum width to the length of the message.
                        <p
                          className="mt-1 line-clamp-3 break-words text-xs text-danger"
                          title={account.lastError}
                        >
                          {account.lastError}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                Timezone {env.timezone} ·{' '}
                {settings
                  ? `runs at ${settings.runTimes || 'no scheduled times'}${
                      settings.newMailPollMinutes > 0 ? ` · new mail every ${settings.newMailPollMinutes} min` : ''
                    }`
                  : 'each mailbox runs on its own schedule'}
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">Latest decisions</CardTitle>
                <CardDescription className="mt-1">The most recent emails the pipeline looked at.</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link href="/activity">
                  All activity
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {!latest.ok || latest.data.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="Nothing processed yet"
                description="Press Run now to process the first batch. With dry run on, nothing in Gmail changes."
                className="py-6"
              />
            ) : (
              <ul className="divide-y">
                {latest.data.map((message) => (
                  <li key={message.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <ActionBadge action={message.userAction ?? message.action} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{message.subject || '(no subject)'}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {message.fromName ?? message.fromAddress}
                        {!selected ? ` · ${emailById.get(message.accountId) ?? ''}` : ''}
                        {' · '}
                        {message.reason}
                      </p>
                    </div>
                    <CategoryBadge category={message.userCategory ?? message.category} names={names} />
                    <ConfidenceMeter value={message.confidence} className="hidden sm:inline-flex" />
                    <DecidedByBadge decidedBy={message.decidedBy} className="hidden sm:inline-flex" />
                    <span className="tnum w-14 text-right text-xs text-muted-foreground">
                      {formatRelative(message.processedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <p className="pb-2 text-center text-xs text-muted-foreground">
          AutoMail never permanently deletes anything: every deletion is a move to Gmail&apos;s Trash, which
          keeps mail for 30 days. {plural(accounts.length, 'mailbox', 'mailboxes')} connected.
        </p>
      </div>
    </LiveProvider>
  );
}
