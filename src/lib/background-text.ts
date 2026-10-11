/**
 * Everything that runs in the background (mail runs and queued jobs), as the
 * dashboard describes it: the shapes the tracker receives and the wording it
 * shows. Free of server imports so the header indicator and the server agree.
 */

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Actions on a set of emails, queued from the review page. */
export const BULK_JOB_ACTIONS = ['TRASH', 'KEEP', 'ARCHIVE', 'DONE', 'RETRY'] as const;
export type BulkJobAction = (typeof BULK_JOB_ACTIONS)[number];

/** Every kind of job; LEARN regenerates one mailbox's learned preferences. */
export const JOB_ACTIONS = [...BULK_JOB_ACTIONS, 'LEARN'] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export type JobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'CANCELLED';

export interface JobDto {
  id: string;
  accountId: string | null;
  accountEmail: string | null;
  action: JobAction;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const WORDS: Record<JobAction, { doing: string; done: string }> = {
  TRASH: { doing: 'Moving to Trash', done: 'moved to Trash' },
  KEEP: { doing: 'Keeping in the inbox', done: 'kept in the inbox' },
  ARCHIVE: { doing: 'Archiving', done: 'archived' },
  DONE: { doing: 'Marking as handled', done: 'marked as handled' },
  RETRY: { doing: 'Sorting again with AI', done: 'sorted again by the AI' },
  LEARN: { doing: 'Updating learned preferences', done: 'updated' },
};

export interface JobProgressLike {
  action: JobAction;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  error: string | null;
}

/** "Moving to Trash", for a job still working. */
export function jobDoing(action: JobAction): string {
  return WORDS[action]?.doing ?? 'Working';
}

function emails(n: number): string {
  return `${n.toLocaleString('en-GB')} email${n === 1 ? '' : 's'}`;
}

/** One sentence on how a finished job went. */
export function jobSummary(job: JobProgressLike): string {
  if (job.action === 'LEARN') {
    if (job.status === 'CANCELLED') return 'Learned preferences were not updated: cancelled.';
    return job.failed > 0
      ? `Learned preferences could not be updated${job.error ? `: ${job.error}` : '.'}`
      : 'Learned preferences updated.';
  }
  const verb = WORDS[job.action]?.done ?? 'updated';
  if (job.status === 'CANCELLED') {
    return `Stopped: ${emails(job.done)} ${verb} before you cancelled; the other ${(job.total - job.done - job.failed).toLocaleString('en-GB')} are back in the queue.`;
  }
  if (job.failed === 0) return `${emails(job.done)} ${verb}.`;
  const reason = job.error ? `: ${job.error}` : '.';
  if (job.done === 0) return `None of the ${emails(job.total)} could be ${verb.split(' ')[0]}${reason}`;
  return `${job.done.toLocaleString('en-GB')} of ${emails(job.total)} ${verb}; ${job.failed.toLocaleString('en-GB')} could not be and are back in the queue${reason}`;
}

/** 0-100, counting failures as settled so the bar always reaches the end. */
export function jobPercent(job: Pick<JobProgressLike, 'total' | 'done' | 'failed'>): number {
  if (job.total <= 0) return 100;
  return Math.min(100, Math.round(((job.done + job.failed) / job.total) * 100));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface BackgroundRunDto {
  id: string;
  accountId: string;
  accountEmail: string;
  trigger: string;
  lane: string;
  /** RUNNING | OK | PARTIAL | FAILED */
  status: string;
  phase: string;
  /** Progress within the phase; total is 0 while still unknown. */
  done: number;
  total: number;
  /** Emails recorded so far (or in all, once finished). */
  processed: number;
  /** How many the daily cap allowed this run; 0 means the cap was already used up. */
  budget: number;
  dryRun: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const RUN_PHASES: Record<string, string> = {
  queued: 'Starting',
  indexing: 'Indexing mailbox',
  reading: 'Reading email',
  sorting: 'Sorting with AI',
  applying: 'Filing in Gmail',
  done: 'Finishing',
};

/** "Sorting with AI", for a run still working. */
export function runDoing(phase: string): string {
  return RUN_PHASES[phase] ?? 'Checking mail';
}

/** One sentence on how a finished run went. */
export function runSummary(
  run: Pick<BackgroundRunDto, 'status' | 'error' | 'processed' | 'dryRun' | 'budget'>,
): string {
  if (run.status === 'OK') {
    if (run.processed === 0 && run.budget === 0) return "Today's cap is already used up, so nothing was processed.";
    return run.processed === 0
      ? 'Nothing new to process.'
      : `${emails(run.processed)} processed${run.dryRun ? ' (dry run)' : ''}.`;
  }
  if (run.error) return run.error;
  return run.status === 'FAILED' ? 'The run failed.' : 'The run finished with problems.';
}

// ---------------------------------------------------------------------------

/** What GET /api/background answers with. */
export interface BackgroundResponse {
  runs: { active: BackgroundRunDto[]; recent: BackgroundRunDto[] };
  jobs: { active: JobDto[]; recent: JobDto[] };
}
