'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Eye, FlaskConical, Loader2, Play } from 'lucide-react';

import { useBackground } from '@/components/shared/background-tasks';
import { Button } from '@/components/ui/button';
import { formatInt } from '@/lib/utils';

export interface UnappliedMailbox {
  id: string;
  email: string;
  count: number;
}

/**
 * Emails sorted while dry run was on are recorded but were never carried out
 * in Gmail, and a recorded email is not offered to a run again. Once dry run
 * is off for a mailbox, this says so and carries those decisions out as a
 * background job, one per mailbox.
 */
export function UnappliedDryRunCard({ mailboxes }: { mailboxes: UnappliedMailbox[] }) {
  const background = useBackground();
  const [queued, setQueued] = useState(false);
  const [busy, setBusy] = useState(false);
  const total = mailboxes.reduce((sum, mailbox) => sum + mailbox.count, 0);
  if (total === 0 || queued) return null;

  async function apply() {
    if (!background) return;
    setBusy(true);
    let any = false;
    for (const mailbox of mailboxes) {
      const job = await background.enqueue({ action: 'APPLY', view: 'dryrun', accountId: mailbox.id });
      any ||= Boolean(job);
    }
    setBusy(false);
    if (any) setQueued(true);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center">
      <FlaskConical className="hidden size-5 shrink-0 text-primary sm:block" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">
          {formatInt(total)} email{total === 1 ? ' was' : 's were'} sorted during dry run but never filed in Gmail
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Dry run only records what the AI would do, and later runs skip emails that already have a decision, so these
          stay in your inbox until applied. Applying labels and files them as decided; proposed deletions go to your
          review queue, nothing is trashed.
          {mailboxes.length > 1 ? ` ${mailboxes.map((m) => `${m.email}: ${formatInt(m.count)}`).join(' · ')}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/activity?status=DRY_RUN">
            <Eye />
            Look first
          </Link>
        </Button>
        <Button size="sm" onClick={() => void apply()} disabled={busy || !background}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />}
          Apply {formatInt(total)}
        </Button>
      </div>
    </div>
  );
}
