'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/client';
import { jobDoing, jobPercent, jobSummary, type JobAction } from '@/lib/job-text';
import type { JobDto } from '@/lib/jobs';
import { cn } from '@/lib/utils';

/** While something is working, often enough for the bar to feel live. */
const ACTIVE_MS = 1_500;
/** Otherwise rarely: only to notice a job started from another device. */
const IDLE_MS = 30_000;

/** Fired on window when a job finishes, so lists can reload. */
export const JOBS_CHANGED_EVENT = 'automail:jobs-changed';

const ANNOUNCED_KEY = 'automail:announced-jobs';

interface JobsResponse {
  active: JobDto[];
  recent: JobDto[];
}

export interface EnqueueRequest {
  action: JobAction;
  ids?: string[];
  view?: 'review' | 'attention';
  accountId?: string;
  category?: string;
}

interface JobsContextValue {
  active: JobDto[];
  /** Queue a bulk action. Resolves once it is queued, not once it is done. */
  enqueue: (request: EnqueueRequest) => Promise<JobDto | null>;
  cancel: (id: string) => Promise<void>;
}

const JobsContext = createContext<JobsContextValue | null>(null);

export function useJobs(): JobsContextValue | null {
  return useContext(JobsContext);
}

function readAnnounced(): Set<string> {
  try {
    const raw = window.localStorage.getItem(ANNOUNCED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeAnnounced(ids: Set<string>): void {
  try {
    window.localStorage.setItem(ANNOUNCED_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    // Private mode or storage blocked: a repeated toast is the only cost.
  }
}

/**
 * Tracks bulk actions running on the server. They carry on with the page
 * closed; this only reports on them: progress while one runs, and a note when
 * one finishes, including ones that finished while the dashboard was closed.
 */
export function JobsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [active, setActive] = useState<JobDto[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);

  const poll = useCallback(async () => {
    try {
      const data = await api<JobsResponse>('/api/bulk');
      busy.current = data.active.length > 0;
      setActive(data.active);

      const announced = readAnnounced();
      const fresh = data.recent.filter((job) => !announced.has(job.id));
      if (fresh.length > 0) {
        for (const job of fresh.reverse()) {
          announced.add(job.id);
          // A single row the user clicked already vanished from the list;
          // only a problem with it is worth a note.
          if (job.total === 1 && job.failed === 0 && job.status === 'DONE') continue;
          const text = jobSummary(job);
          if (job.status === 'CANCELLED') toast.info(text);
          else if (job.failed > 0) toast.warning(text);
          else toast.success(text);
        }
        writeAnnounced(announced);
        window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
        router.refresh();
      }
    } catch {
      // The next poll will tell us.
    }
  }, [router]);

  const schedule = useCallback(
    (ms: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async function tick() {
        if (document.visibilityState === 'visible') await poll();
        timer.current = setTimeout(tick, busy.current ? ACTIVE_MS : IDLE_MS);
      }, ms);
    },
    [poll],
  );

  useEffect(() => {
    // Look now, then at whichever pace what we found calls for: a job found
    // on arrival (or on coming back to the tab) gets live progress at once.
    const check = async () => {
      await poll();
      schedule(busy.current ? ACTIVE_MS : IDLE_MS);
    };
    void check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll, schedule]);

  const enqueue = useCallback(
    async (request: EnqueueRequest) => {
      try {
        const { job } = await api<{ job: JobDto }>('/api/bulk', {
          method: 'POST',
          json: request,
        });
        busy.current = true;
        setActive((prev) => [...prev.filter((j) => j.id !== job.id), job]);
        schedule(ACTIVE_MS);
        // The nav badge and tiles are server-rendered; queued emails have
        // already left those counts.
        router.refresh();
        return job;
      } catch (error) {
        toast.error(errorMessage(error));
        return null;
      }
    },
    [schedule, router],
  );

  const cancel = useCallback(
    async (id: string) => {
      try {
        await api(`/api/bulk/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
        });
        await poll();
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [poll],
  );

  const value = useMemo(() => ({ active, enqueue, cancel }), [active, enqueue, cancel]);
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

/**
 * A small pill in the header while something runs in the background, on
 * every page. Opens to show each job with its progress and a Cancel.
 */
export function JobsIndicator() {
  const jobs = useJobs();
  if (!jobs || jobs.active.length === 0) return null;

  const first = jobs.active[0];
  const total = jobs.active.reduce((sum, job) => sum + job.total, 0);
  const settled = jobs.active.reduce((sum, job) => sum + job.done + job.failed, 0);
  const percent = jobPercent({ total, done: settled, failed: 0 });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex h-8 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border bg-card px-2.5 text-xs font-medium"
          aria-label={`${jobDoing(first.action)}: ${settled} of ${total}`}
        >
          <Loader2 className="size-3.5 animate-spin text-primary" />
          {/* Phones get the percentage alone; wider screens the counts too. */}
          <span className="tnum sm:hidden">{percent}%</span>
          <span className="tnum hidden sm:inline">
            <span className="hidden xl:inline">{jobDoing(first.action)} · </span>
            {settled.toLocaleString('en-GB')}/{total.toLocaleString('en-GB')}
          </span>
          <span
            className="absolute inset-x-0 bottom-0 h-0.5 bg-primary transition-[width] duration-500"
            style={{ width: `${Math.max(3, percent)}%` }}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal normal-case tracking-normal text-muted-foreground">
          Running on the server. You can leave this page or close the browser; it will carry on.
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {jobs.active.map((job) => (
          <JobRow key={job.id} job={job} onCancel={() => void jobs.cancel(job.id)} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function JobRow({ job, onCancel }: { job: JobDto; onCancel: () => void }) {
  const percent = jobPercent(job);
  return (
    <div className="px-2 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{jobDoing(job.action)}</span>
        <span className="tnum ml-auto text-xs text-muted-foreground">
          {job.status === 'QUEUED'
            ? 'Waiting'
            : `${(job.done + job.failed).toLocaleString('en-GB')} of ${job.total.toLocaleString('en-GB')}`}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full bg-primary transition-[width] duration-500',
            job.status === 'QUEUED' && 'opacity-40',
          )}
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>{job.failed > 0 ? `${job.failed} failed so far` : `${percent}%`}</span>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={onCancel}>
          <X className="size-3" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
