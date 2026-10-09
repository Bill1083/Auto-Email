/**
 * How background jobs are described to a person. Free of server imports so
 * the header indicator and the server agree on the wording.
 */

export const JOB_ACTIONS = ['TRASH', 'KEEP', 'ARCHIVE', 'DONE', 'RETRY'] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

const WORDS: Record<JobAction, { doing: string; done: string }> = {
  TRASH: { doing: 'Moving to Trash', done: 'moved to Trash' },
  KEEP: { doing: 'Keeping in the inbox', done: 'kept in the inbox' },
  ARCHIVE: { doing: 'Archiving', done: 'archived' },
  DONE: { doing: 'Marking as handled', done: 'marked as handled' },
  RETRY: { doing: 'Sorting again with AI', done: 'sorted again by the AI' },
};

export interface JobProgressLike {
  action: JobAction;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'CANCELLED';
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
