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
import {
  jobDoing,
  jobPercent,
  jobSummary,
  runDoing,
  runSummary,
  type BackgroundResponse,
  type BackgroundRunDto,
  type BulkJobAction,
  type JobDto,
} from '@/lib/background-text';
import { api, errorMessage } from '@/lib/client';
import { cn } from '@/lib/utils';

/** While something is working, often enough for the bar to feel live. */
const ACTIVE_MS = 1_500;
/** Otherwise rarely: only to notice work started elsewhere (the scheduler, another device). */
const IDLE_MS = 30_000;
/** A run asked for but not yet reported by the server is shown this long at most. */
const PENDING_RUN_MS = 10 * 60_000;

/** Fired on window when background work finishes, so lists and forms can reload. */
export const BACKGROUND_CHANGED_EVENT = 'automail:background-changed';

const ANNOUNCED_KEY = 'automail:announced';

export interface EnqueueRequest {
  action: BulkJobAction;
  ids?: string[];
  view?: 'review' | 'attention';
  accountId?: string;
  category?: string;
}

interface BackgroundContextValue {
  /** False until the first answer from the server. */
  ready: boolean;
  runs: BackgroundRunDto[];
  jobs: JobDto[];
  /** Queue a bulk action. Resolves once it is queued, not once it is done. */
  enqueue: (request: EnqueueRequest) => Promise<JobDto | null>;
  /** Follow a job that was queued some other way (e.g. learned preferences). */
  track: (job: JobDto) => void;
  cancelJob: (id: string) => Promise<void>;
  /** Start a mail run; "all" for every mailbox. Resolves once started. */
  startRun: (accountId: string, lane?: 'new' | 'backlog' | 'both') => Promise<boolean>;
  stopRun: (accountId: string) => Promise<void>;
  /** Is a run working (or about to) for this mailbox; "all" means any. */
  isRunning: (accountId: string) => boolean;
}

const BackgroundContext = createContext<BackgroundContextValue | null>(null);

export function useBackground(): BackgroundContextValue | null {
  return useContext(BackgroundContext);
}

/** Null on the very first visit, so old work is not announced as news. */
function readAnnounced(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(ANNOUNCED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return new Set();
  }
}

function writeAnnounced(ids: Set<string>): void {
  try {
    window.localStorage.setItem(ANNOUNCED_KEY, JSON.stringify([...ids].slice(-100)));
  } catch {
    // Private mode or storage blocked: a repeated note is the only cost.
  }
}

function pendingRun(accountId: string, since: number, accountEmail: string): BackgroundRunDto {
  return {
    id: `pending:${accountId}`,
    accountId,
    accountEmail,
    trigger: 'manual',
    lane: 'both',
    status: 'RUNNING',
    phase: 'queued',
    done: 0,
    total: 0,
    processed: 0,
    budget: 0,
    dryRun: false,
    error: null,
    startedAt: new Date(since).toISOString(),
    finishedAt: null,
  };
}

/**
 * Tracks everything running on the server, for every mailbox: mail runs
 * (however they were started) and queued jobs. None of it depends on this
 * page; this only reports on it, with progress while it works and a note
 * when it finishes, including work that finished while the dashboard was
 * closed.
 */
export function BackgroundProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [runs, setRuns] = useState<BackgroundRunDto[]>([]);
  const [jobs, setJobs] = useState<JobDto[]>([]);
  // Runs asked for that the server has not reported yet: mailbox -> when, and its address.
  const [pending, setPending] = useState<Map<string, number>>(new Map());
  const emails = useRef<Map<string, string>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);

  const poll = useCallback(async () => {
    try {
      const data = await api<BackgroundResponse>('/api/background');
      setRuns(data.runs.active);
      setJobs(data.jobs.active);
      setReady(true);

      // A pending run is settled once it shows up working, or finished.
      setPending((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        for (const [accountId, since] of prev) {
          const seen =
            data.runs.active.some((run) => run.accountId === accountId) ||
            data.runs.recent.some((run) => run.accountId === accountId && Date.parse(run.startedAt) >= since - 5_000);
          if (seen || Date.now() - since > PENDING_RUN_MS) next.delete(accountId);
        }
        return next;
      });

      const finished = [
        ...data.runs.recent.map((run) => ({ key: `run:${run.id}`, run, job: null })),
        ...data.jobs.recent.map((job) => ({ key: `job:${job.id}`, run: null, job })),
      ];
      const announced = readAnnounced();
      if (announced === null) {
        // First visit on this browser: what already finished is not news.
        writeAnnounced(new Set(finished.map((item) => item.key)));
      } else {
        const fresh = finished.filter((item) => !announced.has(item.key));
        if (fresh.length > 0) {
          for (const item of fresh) announced.add(item.key);
          writeAnnounced(announced);
          for (const item of fresh.slice(0, 4)) announce(item.run, item.job);
          window.dispatchEvent(new Event(BACKGROUND_CHANGED_EVENT));
          router.refresh();
        }
      }
      busy.current = data.runs.active.length > 0 || data.jobs.active.length > 0;
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
    // Look now, then at whichever pace what we found calls for: work found
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

  const goLive = useCallback(() => {
    busy.current = true;
    schedule(500);
  }, [schedule]);

  const track = useCallback(
    (job: JobDto) => {
      setJobs((prev) => [...prev.filter((j) => j.id !== job.id), job]);
      goLive();
    },
    [goLive],
  );

  const enqueue = useCallback(
    async (request: EnqueueRequest) => {
      try {
        const { job } = await api<{ job: JobDto }>('/api/bulk', { method: 'POST', json: request });
        track(job);
        // The nav badge and tiles are server-rendered; queued emails have
        // already left those counts.
        router.refresh();
        return job;
      } catch (error) {
        toast.error(errorMessage(error));
        return null;
      }
    },
    [track, router],
  );

  const cancelJob = useCallback(
    async (id: string) => {
      try {
        await api(`/api/bulk/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
        await poll();
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [poll],
  );

  const startRun = useCallback(
    async (accountId: string, lane: 'new' | 'backlog' | 'both' = 'both') => {
      try {
        const data = await api<{
          started: string[];
          accounts?: { id: string; email: string }[];
          alreadyRunning?: boolean;
        }>('/api/runs', {
          method: 'POST',
          json: { accountId, lane },
        });
        for (const account of data.accounts ?? []) emails.current.set(account.id, account.email);
        const now = Date.now();
        setPending((prev) => {
          const next = new Map(prev);
          for (const id of data.started) next.set(id, now);
          return next;
        });
        if (data.alreadyRunning) toast.info('That mailbox is already being checked.');
        else {
          toast.success(
            `Checking ${data.started.length > 1 ? `${data.started.length} mailboxes` : 'mail'} in the background. You can leave this page; progress is in the top bar.`,
          );
        }
        goLive();
        return true;
      } catch (error) {
        toast.error(errorMessage(error));
        return false;
      }
    },
    [goLive],
  );

  const stopRun = useCallback(
    async (accountId: string) => {
      try {
        await api('/api/runs/stop', { method: 'POST', json: { accountId } });
        toast.info('Stopping after the current step. Everything done so far is kept.');
        goLive();
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [goLive],
  );

  // Pending runs show as "Starting" until the server reports them.
  const allRuns = useMemo(() => {
    const placeholders = [...pending.entries()]
      .filter(([accountId]) => !runs.some((run) => run.accountId === accountId))
      .map(([accountId, since]) => pendingRun(accountId, since, emails.current.get(accountId) ?? ''));
    return [...runs, ...placeholders];
  }, [runs, pending]);

  const isRunning = useCallback(
    (accountId: string) =>
      accountId === 'all' ? allRuns.length > 0 : allRuns.some((run) => run.accountId === accountId),
    [allRuns],
  );

  const value = useMemo(
    () => ({ ready, runs: allRuns, jobs, enqueue, track, cancelJob, startRun, stopRun, isRunning }),
    [ready, allRuns, jobs, enqueue, track, cancelJob, startRun, stopRun, isRunning],
  );
  return <BackgroundContext.Provider value={value}>{children}</BackgroundContext.Provider>;
}

/** Long enough to notice on arriving back at the dashboard; longer for problems. */
const NOTE_MS = 10_000;
const PROBLEM_MS = 15_000;

function announce(run: BackgroundRunDto | null, job: JobDto | null): void {
  if (run) {
    const text = `${run.accountEmail ? `${run.accountEmail}: ` : ''}${runSummary(run)}`;
    if (run.status === 'FAILED') toast.error(text, { duration: PROBLEM_MS });
    else if (run.status === 'PARTIAL') toast.warning(text, { duration: PROBLEM_MS });
    else toast.success(text, { duration: NOTE_MS });
    return;
  }
  if (!job) return;
  // A single row the user clicked already vanished from the list; only a
  // problem with it is worth a note.
  if (job.action !== 'LEARN' && job.total === 1 && job.failed === 0 && job.status === 'DONE') return;
  const text = `${job.accountEmail ? `${job.accountEmail}: ` : ''}${jobSummary(job)}`;
  if (job.status === 'CANCELLED') toast.info(text, { duration: NOTE_MS });
  else if (job.failed > 0) toast.warning(text, { duration: PROBLEM_MS });
  else toast.success(text, { duration: NOTE_MS });
}

// ---------------------------------------------------------------------------
// Header indicator
// ---------------------------------------------------------------------------

interface Item {
  key: string;
  label: string;
  email: string | null;
  done: number;
  /** 0 while unknown, shown as an indefinite bar. */
  total: number;
  failed: number;
  waiting: boolean;
  stopLabel: string;
  /** Absent while a run is still starting and has nothing to stop yet. */
  onStop?: () => void;
}

/**
 * A small pill in the header while anything runs in the background, on
 * every page. Opens to list each task with its mailbox, progress and a way
 * to stop it.
 */
export function BackgroundIndicator() {
  const background = useBackground();
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  if (!background) return null;

  const items: Item[] = [
    ...background.runs.map((run) => ({
      key: `run:${run.id}`,
      label: stopping.has(`run:${run.id}`) ? 'Stopping…' : runDoing(run.phase),
      email: run.accountEmail || null,
      done: run.done,
      total: run.total,
      failed: 0,
      waiting: false,
      stopLabel: 'Stop',
      onStop: run.id.startsWith('pending:')
        ? undefined
        : () => {
            setStopping((prev) => new Set(prev).add(`run:${run.id}`));
            void background.stopRun(run.accountId);
          },
    })),
    ...background.jobs.map((job) => ({
      key: `job:${job.id}`,
      label: jobDoing(job.action),
      email: job.accountEmail,
      done: job.action === 'LEARN' ? 0 : job.done,
      total: job.action === 'LEARN' ? 0 : job.total,
      failed: job.failed,
      waiting: job.status === 'QUEUED',
      stopLabel: 'Cancel',
      onStop: () => void background.cancelJob(job.id),
    })),
  ];
  if (items.length === 0) return null;

  const first = items[0];
  const known = first.total > 0;
  const percent = known ? jobPercent(first) : null;
  const more = items.length > 1 ? ` +${items.length - 1}` : '';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex h-8 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border bg-card px-2 text-xs font-medium sm:px-2.5"
          aria-label={`${items.length} background task${items.length === 1 ? '' : 's'}: ${first.label}${
            known ? `, ${first.done + first.failed} of ${first.total}` : ''
          }`}
        >
          <Loader2 className="size-3.5 animate-spin text-primary" />
          {/* Phones get the shortest form; wider screens the counts and the label. */}
          {/* No room for "+1" here; the menu lists every task. */}
          <span className="tnum sm:hidden">{percent !== null ? `${percent}%` : '…'}</span>
          <span className="tnum hidden sm:inline">
            <span className="hidden xl:inline">{first.label} · </span>
            {known
              ? `${(first.done + first.failed).toLocaleString('en-GB')}/${first.total.toLocaleString('en-GB')}`
              : 'working'}
            {more}
          </span>
          {percent !== null ? (
            <span
              className="absolute inset-x-0 bottom-0 h-0.5 bg-primary transition-[width] duration-500"
              style={{ width: `${Math.max(3, percent)}%` }}
            />
          ) : (
            <span className="absolute bottom-0 left-0 h-0.5 w-1/3 animate-sweep bg-primary" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="text-xs font-normal normal-case tracking-normal text-muted-foreground">
          Running on the server. You can switch mailboxes, leave this page or close the browser; it carries on.
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => (
          <TaskRow key={item.key} item={item} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskRow({ item }: { item: Item }) {
  const known = item.total > 0;
  const percent = known ? jobPercent(item) : null;
  return (
    <div className="px-2 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{item.label}</span>
        <span className="tnum ml-auto shrink-0 text-xs text-muted-foreground">
          {item.waiting
            ? 'Waiting'
            : known
              ? `${(item.done + item.failed).toLocaleString('en-GB')} of ${item.total.toLocaleString('en-GB')}`
              : ''}
        </span>
      </div>
      {item.email ? <p className="truncate text-xs text-muted-foreground">{item.email}</p> : null}
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
        {percent !== null ? (
          <div
            className={cn(
              'h-full rounded-full bg-primary transition-[width] duration-500',
              item.waiting && 'opacity-40',
            )}
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        ) : (
          <div className={cn('h-full w-1/3 rounded-full bg-primary animate-sweep', item.waiting && 'opacity-40')} />
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>{item.failed > 0 ? `${item.failed} failed so far` : percent !== null ? `${percent}%` : ''}</span>
        {item.onStop ? (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={item.onStop}>
            <X className="size-3" />
            {item.stopLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
