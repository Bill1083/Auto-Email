'use client';

import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';

import { useLive } from '@/components/overview/live-status';
import { useBackground } from '@/components/shared/background-tasks';
import { Button } from '@/components/ui/button';

/**
 * Starts a run for a mailbox (or all of them). The run works on the server,
 * so this only asks for it; progress, a Stop button and the outcome come from
 * the background tracker in the header, wherever the user goes next.
 */
export function RunNowButton({
  accountId,
  lane = 'both',
  label = 'Run now',
  variant = 'default',
  size = 'default',
  disabled = false,
  initiallyRunning = false,
}: {
  accountId: string;
  lane?: 'new' | 'backlog' | 'both';
  label?: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  size?: 'default' | 'sm';
  disabled?: boolean;
  initiallyRunning?: boolean;
}) {
  const background = useBackground();
  // On the Overview, its own progress bar should start polling at once too.
  const live = useLive();
  const [starting, setStarting] = useState(false);

  const running = background?.ready ? background.isRunning(accountId) : initiallyRunning;
  const busy = starting || running;

  async function start() {
    if (!background) return;
    setStarting(true);
    const started = await background.startRun(accountId, lane);
    setStarting(false);
    if (started) live?.refreshNow();
  }

  return (
    <Button onClick={start} disabled={disabled || busy || !background} variant={variant} size={size}>
      {busy ? <Loader2 className="animate-spin" /> : <Play />}
      {busy ? 'Running…' : label}
    </Button>
  );
}
