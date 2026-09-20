'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ListChecks, Loader2, Mail, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { StatCard, type StatCardProps } from '@/components/stat-card';
import type { LiveResponse } from '@/app/api/live/route';
import { api } from '@/lib/client';
import { cn, formatInt } from '@/lib/utils';

/** While a run works, every couple of seconds; otherwise rarely. */
const ACTIVE_MS = 2_000;
const IDLE_MS = 20_000;

interface LiveContextValue {
  live: LiveResponse;
  running: boolean;
  /** Poll again immediately, e.g. just after starting a run. */
  refreshNow: () => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

/** Null outside a provider, so a component can work on pages without one. */
export function useLive(): LiveContextValue | null {
  return useContext(LiveContext);
}

/**
 * Polls the handful of numbers that move while email is being sorted, and
 * refreshes the whole page once a run finishes so the chart, costs and recent
 * decisions catch up. Polling backs right off when nothing is running and
 * stops entirely while the tab is hidden.
 */
export function LiveProvider({
  accountId,
  initial,
  children,
}: {
  accountId: string;
  initial: LiveResponse;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [live, setLive] = useState<LiveResponse>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasRunning = useRef(Boolean(initial.run));
  const announced = useRef<string | null>(initial.lastFinished?.id ?? null);

  const running = live.run !== null;

  const poll = useCallback(async () => {
    try {
      const next = await api<LiveResponse>(`/api/live?accountId=${encodeURIComponent(accountId)}`);
      setLive(next);

      // A run that has just finished: say how it went, once, and pull in the
      // parts of the page this endpoint deliberately does not carry.
      if (wasRunning.current && !next.run) {
        const finished = next.lastFinished;
        if (finished && announced.current !== finished.id) {
          announced.current = finished.id;
          if (finished.status === 'FAILED') toast.error(finished.error ?? 'The run failed.');
          else if (finished.status === 'PARTIAL') {
            toast.warning(finished.error ?? 'The run finished with problems.');
          } else {
            toast.success(
              finished.fetched === 0
                ? 'Nothing new to process.'
                : `${formatInt(finished.fetched)} email${finished.fetched === 1 ? '' : 's'} processed${finished.dryRun ? ' (dry run)' : ''}.`,
            );
          }
        }
        router.refresh();
      }
      wasRunning.current = Boolean(next.run);
    } catch {
      // A failed poll is not worth surfacing; the next one will tell us.
    }
  }, [accountId, router]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        await poll();
      }
      if (cancelled) return;
      timer.current = setTimeout(tick, wasRunning.current ? ACTIVE_MS : IDLE_MS);
    };

    timer.current = setTimeout(tick, wasRunning.current ? ACTIVE_MS : IDLE_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  const refreshNow = useCallback(() => {
    wasRunning.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void poll(), 400);
  }, [poll]);

  const value = useMemo<LiveContextValue>(() => ({ live, running, refreshNow }), [live, running, refreshNow]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const PHASE: Record<string, { title: string; unit: string }> = {
  queued: { title: 'Starting', unit: '' },
  indexing: { title: 'Indexing mailbox', unit: 'found' },
  reading: { title: 'Reading email', unit: '' },
  sorting: { title: 'Sorting with AI', unit: '' },
  applying: { title: 'Filing in Gmail', unit: '' },
  done: { title: 'Finishing', unit: '' },
};

/**
 * A thin bar that only exists while a run does. Indexing has no known total
 * until it ends, so it shows a moving segment and a running count instead of
 * a percentage it would have to invent.
 */
export function RunProgress({ showMailbox = false }: { showMailbox?: boolean }) {
  const context = useLive();
  const run = context?.live.run ?? null;
  if (!run) return null;

  const phase = PHASE[run.phase] ?? PHASE.queued;
  const known = run.total > 0;
  const percent = known ? Math.min(100, Math.round((run.done / run.total) * 100)) : null;

  return (
    <div className="rounded-lg border bg-card px-3 py-2.5" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        <span className="font-medium">{phase.title}</span>
        <span className="tnum text-muted-foreground">
          {known
            ? `${formatInt(run.done)} of ${formatInt(run.total)}`
            : run.done > 0
              ? `${formatInt(run.done)} ${phase.unit}`.trim()
              : ''}
        </span>
        {showMailbox ? (
          <span className="truncate text-xs text-muted-foreground">· {run.accountEmail}</span>
        ) : null}
        {run.dryRun ? <span className="text-xs text-muted-foreground">· dry run</span> : null}
        {percent !== null ? (
          <span className="tnum ml-auto text-xs text-muted-foreground">{percent}%</span>
        ) : null}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        {percent !== null ? (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        ) : (
          <div className="h-full w-1/3 rounded-full bg-primary animate-sweep" />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

type LiveField = 'awaitingReview' | 'needsAttention' | 'processedToday';

/**
 * A component reference cannot cross from a server component into a client
 * one, so the tile names its icon and looks it up here.
 */
const ICONS = {
  mail: Mail,
  review: ListChecks,
  attention: TriangleAlert,
} as const;

/**
 * A StatCard whose number follows the live counts, so the review and
 * attention queues visibly fill while a run works. It starts from the
 * server-rendered value, so it is correct before the first poll.
 *
 * Every prop is plain data: a server component cannot hand a client component
 * a formatter or a callback, so the two shapes a tile needs (something vs
 * nothing) are passed as values instead.
 */
export function LiveStatCard({
  field,
  initial,
  suffix = '',
  hint,
  zeroHint,
  tone = 'default',
  zeroTone,
  icon,
  ...props
}: Omit<StatCardProps, 'value' | 'hint' | 'tone' | 'icon'> & {
  field: LiveField;
  initial: number;
  icon: keyof typeof ICONS;
  /** Appended after the number, e.g. " / 300". */
  suffix?: string;
  hint?: string;
  /** Used in place of `hint` while the live value is zero. */
  zeroHint?: string;
  tone?: StatCardProps['tone'];
  /** Used in place of `tone` while the live value is zero. */
  zeroTone?: StatCardProps['tone'];
}) {
  const context = useLive();
  const value = context ? context.live[field] : initial;
  const [flash, setFlash] = useState(false);
  const previous = useRef(value);

  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setFlash(true);
    const id = setTimeout(() => setFlash(false), 1_200);
    return () => clearTimeout(id);
  }, [value]);

  const empty = value === 0;

  return (
    <StatCard
      {...props}
      icon={ICONS[icon]}
      value={`${formatInt(value)}${suffix}`}
      hint={empty && zeroHint !== undefined ? zeroHint : hint}
      tone={empty && zeroTone !== undefined ? zeroTone : tone}
      className={cn(
        'transition-shadow duration-500',
        flash && 'shadow-[0_0_0_1px_hsl(var(--primary))]',
        props.className,
      )}
    />
  );
}
