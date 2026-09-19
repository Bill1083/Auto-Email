import { ArrowUpRight, Inbox } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Shown where a page edits one mailbox's settings but "All accounts" is
 * selected. Every setting belongs to a mailbox, so there is nothing to edit
 * until one is chosen in the top-right switcher.
 */
export function ChooseMailbox({
  title,
  what,
  hasMailboxes,
}: {
  title: string;
  /** What the user will be able to edit once a mailbox is chosen. */
  what: string;
  hasMailboxes: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription className="mt-1">
          Each mailbox has its own {what}, and nothing is shared between them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-3 rounded-md border border-dashed px-4 py-5 text-sm">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            {hasMailboxes ? <ArrowUpRight className="size-4" /> : <Inbox className="size-4" />}
          </span>
          <div>
            <p className="font-medium">
              {hasMailboxes ? 'Choose a mailbox in the top right' : 'Connect a mailbox first'}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {hasMailboxes
                ? `You are viewing all accounts. Pick one from the mailbox menu at the top right to see and change its ${what}.`
                : `Once a mailbox is connected below, its ${what} appear here.`}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
