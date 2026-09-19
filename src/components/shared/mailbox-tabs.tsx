'use client';

import { AccountAvatar } from '@/components/account-switcher';
import { cn } from '@/lib/utils';

export interface MailboxOption {
  id: string;
  email: string;
}

/**
 * Picks which mailbox a per-mailbox card is editing. Hidden when there is only
 * one mailbox — there is nothing to switch between, and the card's description
 * already names it.
 */
export function MailboxTabs({
  mailboxes,
  activeId,
  onSelect,
  className,
}: {
  mailboxes: MailboxOption[];
  activeId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  if (mailboxes.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="Mailbox"
      className={cn('flex flex-wrap gap-1 rounded-md bg-muted/50 p-1', className)}
    >
      {mailboxes.map((mailbox) => {
        const active = mailbox.id === activeId;
        return (
          <button
            key={mailbox.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(mailbox.id)}
            className={cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
              active
                ? 'bg-card font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <AccountAvatar email={mailbox.email} className="size-5 text-[9px]" />
            <span className="max-w-[200px] truncate">{mailbox.email}</span>
          </button>
        );
      })}
    </div>
  );
}
