'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { ActionBadge, CategoryBadge, ConfidenceMeter, DecidedByBadge } from '@/components/shared/badges';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/client';
import type { MessageDto } from '@/lib/serialize';

/**
 * Fetches a longer excerpt from the mailbox on open. Bodies are never stored
 * locally, so this is the only place the app shows more than a snippet.
 */
export function MessagePreview({
  message,
  names,
  onOpenChange,
}: {
  message: MessageDto | null;
  names?: Record<string, string>;
  onOpenChange: (open: boolean) => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!message) return;
    let cancelled = false;
    setBody(null);
    setError(null);
    api<{ body: string }>(`/api/messages/${message.id}/body`)
      .then((data) => {
        if (!cancelled) setBody(data.body);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [message]);

  return (
    <Dialog open={message !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {message ? (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">{message.subject || '(no subject)'}</DialogTitle>
              <DialogDescription className="break-all">
                {message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}
                {' · '}
                {new Date(message.internalDate).toLocaleString()}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <ActionBadge action={message.userAction ?? message.action} />
              <CategoryBadge category={message.userCategory ?? message.category} names={names} />
              <ConfidenceMeter value={message.confidence} />
              <DecidedByBadge decidedBy={message.decidedBy} />
            </div>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <span className="font-medium">Why: </span>
              {message.reason}
              {message.guardNote ? (
                <span className="mt-1 block text-xs text-muted-foreground">{message.guardNote}</span>
              ) : null}
            </p>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border bg-background p-3 text-sm scrollbar-thin">
              {error ? (
                <p className="text-danger">{error}</p>
              ) : body === null ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Fetching from the mailbox…
                </p>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-sans">{body || '(empty body)'}</pre>
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
