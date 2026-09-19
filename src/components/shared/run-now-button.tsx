'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/client';

interface RunsResponse {
  running: boolean;
  runs: { id: string; status: string; error: string | null; fetched: number; dryRun: boolean }[];
}

/**
 * Starts a run for the selected mailbox (or all of them) and polls until it
 * finishes, then refreshes the page so every tile reflects the result.
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
  const router = useRouter();
  const [running, setRunning] = useState(initiallyRunning);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function poll(attempt = 0) {
    try {
      const data = await api<RunsResponse>(`/api/runs?accountId=${encodeURIComponent(accountId)}&limit=5`);
      if (data.running && attempt < 600) {
        timer.current = setTimeout(() => void poll(attempt + 1), 2_000);
        return;
      }
      setRunning(false);
      const latest = data.runs[0];
      if (latest?.status === 'FAILED') toast.error(latest.error ?? 'The run failed.');
      else if (latest?.status === 'PARTIAL') toast.warning(latest.error ?? 'The run finished with problems.');
      else if (latest) {
        toast.success(
          latest.fetched === 0
            ? 'Nothing new to process.'
            : `${latest.fetched} email${latest.fetched === 1 ? '' : 's'} processed${latest.dryRun ? ' (dry run)' : ''}.`,
        );
      }
      router.refresh();
    } catch (error) {
      setRunning(false);
      toast.error(errorMessage(error));
    }
  }

  async function start() {
    setRunning(true);
    try {
      await api('/api/runs', { method: 'POST', json: { accountId, lane } });
      timer.current = setTimeout(() => void poll(), 1_500);
    } catch (error) {
      setRunning(false);
      toast.error(errorMessage(error));
    }
  }

  return (
    <Button onClick={start} disabled={disabled || running} variant={variant} size={size}>
      {running ? <Loader2 className="animate-spin" /> : <Play />}
      {running ? 'Running…' : label}
    </Button>
  );
}
