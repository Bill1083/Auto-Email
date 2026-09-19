'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Link2, Loader2, Mail, Pause, Play, RefreshCw, RotateCcw, Unplug } from 'lucide-react';
import { toast } from 'sonner';

import { AccountAvatar } from '@/components/account-switcher';
import { EmptyState } from '@/components/shared/empty-state';
import { RunNowButton } from '@/components/shared/run-now-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/client';
import type { AccountDto } from '@/lib/serialize';
import { formatRelative } from '@/lib/time';
import { formatInt } from '@/lib/utils';

export function AccountsPanel({
  accounts,
  googleConfigured,
  encryptionConfigured,
  mockMail,
  redirectUri,
  loginRedirectUri,
  loginEmail,
  loginMailboxConnected,
  scoped,
}: {
  /** The mailboxes to show: just the selected one, or all on "All accounts". */
  accounts: AccountDto[];
  googleConfigured: boolean;
  encryptionConfigured: boolean;
  mockMail: boolean;
  redirectUri: string;
  loginRedirectUri: string;
  loginEmail: string | null;
  /** Checked against every mailbox, not just the ones shown. */
  loginMailboxConnected: boolean;
  /** True when a single mailbox is selected in the top right. */
  scoped: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<AccountDto | null>(null);

  // The OAuth callback lands here with ?connected= or ?error=.
  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (connected) toast.success(`${connected} connected.`);
    if (error) toast.error(error);
    if (connected || error) router.replace('/settings');
  }, [params, router]);

  async function mutate(id: string, request: () => Promise<unknown>, success?: string) {
    setBusy(id);
    try {
      await request();
      if (success) toast.success(success);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const canConnect = googleConfigured && encryptionConfigured;
  const loginMailboxMissing = canConnect && loginEmail !== null && !loginMailboxConnected;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{scoped ? 'This mailbox' : 'Mailboxes'}</CardTitle>
            <CardDescription className="mt-1">
              {scoped
                ? 'The connection for the mailbox selected in the top right. Connect another here, then switch to it from that menu.'
                : 'Every connected mailbox. Each is connected with the gmail.modify scope, which can label, archive and trash but never permanently delete.'}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {mockMail ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy === 'mock'}
                onClick={() => mutate('mock', () => api('/api/accounts', { method: 'POST', json: { kind: 'mock' } }), 'Demo mailbox added.')}
              >
                {busy === 'mock' ? <Loader2 className="animate-spin" /> : <Mail />}
                Add demo mailbox
              </Button>
            ) : null}
            <Button asChild size="sm" disabled={!canConnect}>
              <a
                href={canConnect ? '/api/google/start' : undefined}
                aria-disabled={!canConnect}
                title={
                  canConnect
                    ? 'Connect a Gmail account'
                    : !encryptionConfigured
                      ? 'Set TOKEN_ENCRYPTION_KEY first'
                      : 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first'
                }
                className={!canConnect ? 'pointer-events-none opacity-50' : undefined}
              >
                <Link2 />
                Connect Gmail
              </a>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!googleConfigured ? (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Google OAuth is not configured.</p>
            <p className="mt-1">
              Create an OAuth client (Web application) in Google Cloud Console with both redirect URIs below,
              then put its ID and secret in <code>.env</code>. Full steps are in DEPLOYMENT.md.
            </p>
            <code className="mt-1 block select-all break-all rounded bg-background px-2 py-1">{redirectUri}</code>
            <code className="mt-1 block select-all break-all rounded bg-background px-2 py-1">{loginRedirectUri}</code>
          </div>
        ) : null}

        {loginMailboxMissing ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              You signed in as <strong>{loginEmail}</strong>, but that mailbox is not connected yet. Connecting it
              is a separate, one-time permission for reading and labelling mail.
            </span>
            <Button asChild size="sm">
              <a href={`/api/google/start?hint=${encodeURIComponent(loginEmail ?? '')}`}>
                <Link2 />
                Connect this mailbox
              </a>
            </Button>
          </div>
        ) : null}

        {accounts.length === 0 ? (
          <EmptyState
            icon={Mail}
            title="No mailbox connected"
            description={
              mockMail
                ? 'Add the demo mailbox to try everything without Google, or connect a real Gmail account.'
                : 'Connect a Gmail account to begin. Set MOCK_MAIL=true in .env to explore with a demo mailbox first.'
            }
            className="py-6"
          />
        ) : (
          <ul className="space-y-3">
            {accounts.map((account) => {
              return (
                <li key={account.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <AccountAvatar email={account.email} className="size-8 text-xs" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{account.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {account.provider === 'mock' ? 'Demo mailbox' : 'Gmail'} · connected{' '}
                        {formatRelative(account.createdAt)} · new mail checked{' '}
                        {formatRelative(account.lastNewLaneAt)} ·{' '}
                        {account.backlogBuiltAt
                          ? account.backlogDone
                            ? 'backlog done'
                            : `${formatInt(account.backlogEstimate ?? 0)} left in backlog`
                          : 'backlog starts on the first run'}
                      </p>
                    </div>
                    <Badge
                      variant={
                        account.status === 'ACTIVE' ? 'success' : account.status === 'NEEDS_REAUTH' ? 'warning' : 'secondary'
                      }
                    >
                      {account.status === 'ACTIVE' ? 'Active' : account.status === 'NEEDS_REAUTH' ? 'Needs reconnecting' : 'Paused'}
                    </Badge>
                  </div>
                  {account.lastError ? (
                    <p className="mt-2 rounded bg-danger/10 px-2 py-1 text-xs text-danger">{account.lastError}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="ml-auto flex flex-wrap gap-1.5">
                      {account.status === 'ACTIVE' ? (
                        <RunNowButton accountId={account.id} size="sm" variant="outline" label="Run now" />
                      ) : null}
                      {account.status === 'NEEDS_REAUTH' && account.provider === 'gmail' ? (
                        <Button asChild size="sm">
                          <a href={`/api/google/start?hint=${encodeURIComponent(account.email)}`}>
                            <RefreshCw />
                            Reconnect
                          </a>
                        </Button>
                      ) : null}
                      {account.status !== 'NEEDS_REAUTH' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === account.id}
                          onClick={() =>
                            mutate(
                              account.id,
                              () =>
                                api(`/api/accounts/${account.id}`, {
                                  method: 'PATCH',
                                  json: { status: account.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED' },
                                }),
                              account.status === 'PAUSED' ? 'Resumed.' : 'Paused. Scheduled runs skip this mailbox.',
                            )
                          }
                        >
                          {account.status === 'PAUSED' ? <Play /> : <Pause />}
                          {account.status === 'PAUSED' ? 'Resume' : 'Pause'}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === account.id}
                        title="Forget the backlog snapshot; it is rebuilt on the next run"
                        onClick={() =>
                          mutate(
                            account.id,
                            () => api(`/api/accounts/${account.id}`, { method: 'PATCH', json: { resetBacklog: true } }),
                            'Backlog reset; it will be rebuilt on the next run.',
                          )
                        }
                      >
                        <RotateCcw />
                        Reset backlog
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-danger"
                        disabled={busy === account.id}
                        onClick={() => setDisconnecting(account)}
                      >
                        <Unplug />
                        Disconnect
                      </Button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Dialog open={disconnecting !== null} onOpenChange={(open) => !open && setDisconnecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {disconnecting?.email}?</DialogTitle>
            <DialogDescription>
              The stored token is revoked and this mailbox&apos;s history is removed from the dashboard. Labels already
              applied in Gmail stay exactly as they are; nothing in the mailbox is deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnecting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={async () => {
                const account = disconnecting;
                setDisconnecting(null);
                if (!account) return;
                await mutate(account.id, () => api(`/api/accounts/${account.id}`, { method: 'DELETE' }), 'Disconnected.');
              }}
            >
              <Unplug />
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
