import Link from 'next/link';
import { CheckCircle2, Circle, Info } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { IntegrationStatus } from '@/lib/env';
import { cn } from '@/lib/utils';

interface Item {
  done: boolean;
  label: string;
  hint: string;
  info?: boolean;
}

export function SetupChecklist({
  status,
  accountCount,
  dryRun,
  needsReauth,
}: {
  status: IntegrationStatus;
  accountCount: number;
  dryRun: boolean;
  needsReauth: number;
}) {
  const items: Item[] = [
    {
      done: status.encryption,
      label: 'Token encryption key',
      hint: 'Set TOKEN_ENCRYPTION_KEY in .env (openssl rand -base64 32) so mailbox tokens are stored encrypted.',
    },
    {
      done: status.google || status.mockMail,
      label: 'Google OAuth client',
      hint: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or MOCK_MAIL=true to try the demo mailbox.',
    },
    {
      done: status.gemini,
      label: 'Gemini API key',
      hint: 'Without GEMINI_API_KEY, emails no rule matches go to "Needs attention" instead of being classified.',
    },
    {
      done: accountCount > 0,
      label: 'A connected mailbox',
      hint: 'Connect a Gmail account (or the demo mailbox) from Settings.',
    },
    {
      done: needsReauth === 0,
      label: 'All mailboxes connected',
      hint: `${needsReauth} account${needsReauth === 1 ? '' : 's'} need reconnecting from Settings.`,
    },
    {
      done: !dryRun,
      label: 'Dry run switched off',
      hint: 'Decisions are logged but nothing is applied to Gmail. Turn it off in Settings once you trust the results.',
      info: true,
    },
  ];
  const outstanding = items.filter((item) => !item.done);
  if (outstanding.length === 0) return null;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Setup</CardTitle>
        <CardDescription className="mt-1">
          A few things are still needed before AutoMail can work on its own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.label} className="flex items-start gap-2.5 text-sm">
              {item.done ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
              ) : item.info ? (
                <Info className="mt-0.5 size-4 shrink-0 text-warning" />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <p className={cn('font-medium', item.done && 'text-muted-foreground line-through')}>{item.label}</p>
                {!item.done ? <p className="text-xs text-muted-foreground">{item.hint}</p> : null}
              </div>
            </li>
          ))}
        </ul>
        <Button asChild size="sm" variant="outline" className="mt-2">
          <Link href="/settings">Open settings</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
