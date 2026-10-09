/**
 * Background jobs for bulk actions.
 *
 * A bulk action used to run inside the request that asked for it, so the
 * browser had to stay open until Gmail was done, and closing the tab abandoned
 * the rest. Now the click only records a job and marks its messages as queued
 * (which takes them out of the review queues at once), and this worker does
 * the mailbox work in the server process, whether or not anyone is watching.
 *
 * A job saves the ids it has left after every chunk, so a restart resumes it
 * where it stopped. Jobs run one at a time in the order they were queued; the
 * work inside each is parallel where Gmail allows it (see `bulkAction`).
 */

import type { Job } from '@prisma/client';

import type { JobAction } from '@/lib/job-text';
import { BULK_CHUNK_LIMIT, bulkAction, type BulkOutcome } from '@/lib/pipeline/feedback';
import { prisma, withDatabase } from '@/lib/prisma';

export const MAX_JOB_IDS = 5_000;

const ACTIVE = ['QUEUED', 'RUNNING'];

/** Finished jobs stay listed this long, for the "while you were away" note. */
const RECENT_MS = 24 * 3_600_000;
/** And are deleted after this long. */
const KEEP_MS = 7 * 86_400_000;

export interface JobDto {
  id: string;
  accountId: string | null;
  action: JobAction;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'CANCELLED';
  total: number;
  done: number;
  failed: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export function serializeJob(job: Job): JobDto {
  return {
    id: job.id,
    accountId: job.accountId,
    action: job.action as JobAction,
    status: job.status as JobDto['status'],
    total: job.total,
    done: job.done,
    failed: job.failed,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

function parseIds(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  accountId: string | null;
  action: JobAction;
  ids: string[];
  category?: string | null;
  note?: string | null;
}

/**
 * Record the job and claim its messages, in one transaction so two quick
 * clicks cannot both claim the same email. Messages another job already holds
 * are left to that job.
 */
export async function enqueueJob(input: EnqueueInput): Promise<Job> {
  const ids = [...new Set(input.ids)].slice(0, MAX_JOB_IDS);
  const job = await prisma.$transaction(async (tx) => {
    const free = await tx.message.findMany({
      where: { id: { in: ids }, queuedJobId: null },
      select: { id: true },
    });
    const freeIds = new Set(free.map((row) => row.id));
    // Keep the caller's order, which is the order the user saw.
    const pending = ids.filter((id) => freeIds.has(id));
    const created = await tx.job.create({
      data: {
        accountId: input.accountId,
        action: input.action,
        category: input.category ?? null,
        note: input.note ?? null,
        total: pending.length,
        pendingJson: JSON.stringify(pending),
        ...(pending.length === 0 ? { status: 'DONE', finishedAt: new Date() } : {}),
      },
    });
    if (pending.length > 0) {
      await tx.message.updateMany({ where: { id: { in: pending } }, data: { queuedJobId: created.id } });
    }
    return created;
  });
  kickJobs();
  return job;
}

/** Stop a job. Emails it had not reached go back to their queues at once. */
export async function cancelJob(id: string): Promise<Job | null> {
  const updated = await prisma.job.updateMany({
    where: { id, status: { in: ACTIVE } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  if (updated.count > 0) await release(id);
  return prisma.job.findUnique({ where: { id } });
}

/** Jobs still working, plus the ones that finished recently. */
export async function listJobs(now = new Date()): Promise<{ active: Job[]; recent: Job[] }> {
  const [active, recent] = await Promise.all([
    prisma.job.findMany({ where: { status: { in: ACTIVE } }, orderBy: { createdAt: 'asc' } }),
    prisma.job.findMany({
      where: { status: { notIn: ACTIVE }, finishedAt: { gte: new Date(now.getTime() - RECENT_MS) } },
      orderBy: { finishedAt: 'desc' },
      take: 5,
    }),
  ]);
  return { active, recent };
}

/** Hand messages back to their queues: the given ones, or all the job holds. */
async function release(jobId: string, ids?: string[]): Promise<void> {
  await withDatabase(() =>
    prisma.message.updateMany({
      where: { queuedJobId: jobId, ...(ids ? { id: { in: ids } } : {}) },
      data: { queuedJobId: null },
    }),
  );
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

interface WorkerState {
  running: boolean;
  /** A job arrived while the worker was finishing up; look again. */
  again: boolean;
  booted: boolean;
}

const globalWorker = globalThis as unknown as { __automailJobs?: WorkerState };

function workerState(): WorkerState {
  globalWorker.__automailJobs ??= { running: false, again: false, booted: false };
  return globalWorker.__automailJobs;
}

/** Make sure the worker is draining the queue. Cheap to call often. */
export function kickJobs(): void {
  const state = workerState();
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true;
  void drain(state).finally(() => {
    state.running = false;
  });
}

/**
 * Once per process: hand back messages held by jobs that no longer exist or
 * already finished (a crash between two writes), forget old jobs, and resume
 * anything a restart interrupted.
 */
export async function startJobWorker(): Promise<void> {
  const state = workerState();
  if (state.booted) return;
  state.booted = true;
  await withDatabase(async () => {
    const active = await prisma.job.findMany({ where: { status: { in: ACTIVE } }, select: { id: true } });
    await prisma.message.updateMany({
      where: { queuedJobId: { not: null, notIn: active.map((job) => job.id) } },
      data: { queuedJobId: null },
    });
    await prisma.job.deleteMany({
      where: { status: { notIn: ACTIVE }, createdAt: { lt: new Date(Date.now() - KEEP_MS) } },
    });
    if (active.length > 0) console.log(`[automail] resuming ${active.length} background job(s)`);
  });
  kickJobs();
}

async function drain(state: WorkerState): Promise<void> {
  do {
    state.again = false;
    for (;;) {
      const next = await withDatabase(() =>
        prisma.job.findFirst({ where: { status: { in: ACTIVE } }, orderBy: { createdAt: 'asc' } }),
      );
      if (!next.ok || !next.data) break;
      try {
        await work(next.data);
      } catch (error) {
        // Never spin on one broken job: close it and give its emails back.
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[automail] job ${next.data.id} failed:`, message);
        await withDatabase(() =>
          prisma.job.updateMany({
            where: { id: next.data!.id, status: { in: ACTIVE } },
            data: { status: 'DONE', finishedAt: new Date(), error: message },
          }),
        );
        await release(next.data.id);
      }
    }
  } while (state.again);
}

async function work(job: Job): Promise<void> {
  let pending = parseIds(job.pendingJson);
  let { done, failed } = job;
  let error = job.error;
  const started = Date.now();

  await prisma.job.update({
    where: { id: job.id },
    data: { status: 'RUNNING', startedAt: job.startedAt ?? new Date() },
  });
  console.log(`[automail] job ${job.id}: ${job.action} for ${pending.length} email(s)`);

  while (pending.length > 0) {
    // Checked between chunks, so Cancel takes effect within one chunk.
    const current = await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } });
    if (!current || current.status === 'CANCELLED') {
      await release(job.id);
      console.log(`[automail] job ${job.id}: cancelled with ${pending.length} left`);
      return;
    }

    const slice = pending.slice(0, BULK_CHUNK_LIMIT);
    let outcome: BulkOutcome;
    try {
      outcome = await bulkAction(slice, { action: job.action as JobAction, category: job.category, note: job.note });
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : 'Unknown error';
      outcome = { done: [], failed: slice.map((id) => ({ id, error: reason })), remaining: [] };
    }
    // A chunk that settled nothing would otherwise be offered again forever.
    if (outcome.done.length === 0 && outcome.failed.length === 0) {
      outcome = { done: [], failed: slice.map((id) => ({ id, error: 'Ran out of time.' })), remaining: [] };
    }

    pending = [...outcome.remaining, ...pending.slice(slice.length)];
    done += outcome.done.length;
    failed += outcome.failed.length;
    error ??= outcome.failed[0]?.error ?? null;

    // Done ones have left the queues on their own; failed ones go back so
    // they can be seen and tried again.
    await release(job.id, [...outcome.done, ...outcome.failed.map((entry) => entry.id)]);
    await prisma.job.update({
      where: { id: job.id },
      data: { done, failed, error, pendingJson: JSON.stringify(pending) },
    });
  }

  // Not over a cancel that landed during the last chunk.
  await prisma.job.updateMany({
    where: { id: job.id, status: 'RUNNING' },
    data: { status: 'DONE', finishedAt: new Date() },
  });
  await release(job.id);
  console.log(
    `[automail] job ${job.id}: ${done} done, ${failed} failed in ${Math.round((Date.now() - started) / 1000)}s`,
  );
}
