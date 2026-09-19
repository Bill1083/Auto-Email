'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, ChevronsUpDown, Inbox, Plus } from 'lucide-react';
import { toast } from 'sonner';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/client';
import type { AccountDto } from '@/lib/serialize';
import { cn, hueFor, initials } from '@/lib/utils';

export function AccountAvatar({ email, className }: { email: string; className?: string }) {
  const hue = hueFor(email);
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
        className,
      )}
      style={{
        backgroundColor: `hsl(${hue} 60% 40% / 0.25)`,
        color: `hsl(${hue} 70% 65%)`,
      }}
    >
      {initials(email)}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'ACTIVE' && 'bg-success',
        status === 'NEEDS_REAUTH' && 'bg-warning',
        status === 'PAUSED' && 'bg-muted-foreground/50',
      )}
      title={status === 'ACTIVE' ? 'Active' : status === 'NEEDS_REAUTH' ? 'Needs reconnecting' : 'Paused'}
    />
  );
}

export function AccountSwitcher({
  accounts,
  selectedId,
}: {
  accounts: AccountDto[];
  selectedId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const selected = accounts.find((a) => a.id === selectedId) ?? null;
  const isAll = selectedId === 'all';

  async function select(id: string) {
    if (id === selectedId) return;
    setBusy(true);
    try {
      await api('/api/accounts/select', { method: 'POST', json: { accountId: id } });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <button
        type="button"
        onClick={() => router.push('/settings')}
        className="flex h-9 items-center gap-2 rounded-md border border-dashed px-3 text-sm text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
      >
        <Plus className="size-4" />
        <span className="hidden sm:inline">Connect a mailbox</span>
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label="Switch mailbox"
          className="flex h-9 max-w-[220px] items-center gap-2 rounded-md border bg-card px-2.5 text-sm transition-colors hover:bg-secondary/60 disabled:opacity-60"
        >
          {isAll || !selected ? (
            <span className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Inbox className="size-3.5" />
            </span>
          ) : (
            <AccountAvatar email={selected.email} />
          )}
          <span className="hidden min-w-0 truncate font-medium sm:inline">
            {isAll || !selected ? `All accounts (${accounts.length})` : selected.email}
          </span>
          {selected && !isAll ? <StatusDot status={selected.status} /> : null}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Mailbox</DropdownMenuLabel>
        {accounts.length > 1 ? (
          <DropdownMenuItem onSelect={() => select('all')}>
            <span className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Inbox className="size-3.5" />
            </span>
            <span className="flex-1">All accounts</span>
            {isAll ? <Check className="text-primary" /> : null}
          </DropdownMenuItem>
        ) : null}
        {accounts.map((account) => (
          <DropdownMenuItem key={account.id} onSelect={() => select(account.id)}>
            <AccountAvatar email={account.email} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{account.email}</span>
              <span className="text-[11px] text-muted-foreground">
                {account.status === 'ACTIVE'
                  ? account.provider === 'mock'
                    ? 'Demo mailbox'
                    : 'Connected'
                  : account.status === 'NEEDS_REAUTH'
                    ? 'Needs reconnecting'
                    : 'Paused'}
              </span>
            </span>
            <StatusDot status={account.status} />
            {account.id === selectedId ? <Check className="text-primary" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/settings')}>
          <Plus />
          Connect another mailbox
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
