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
 * where it stopped. Jobs for different mailboxes run side by side; jobs for
 * the same mailbox take turns in the order they were queued, because Gmail's
 * limits are per mailbox. The work inside each is parallel too, where Gmail
 * allows it (see `bulkAction`).
 *
 * Besides bulk actions on emails, a job can be LEARN: regenerating one
 * mailbox's learned preferences, which is a slow model call worth not
 * holding a browser open for.
 */

import type { Job } from '@prisma/client';

import type { BulkJobAction, JobAction, JobDto } from '@/lib/background-text';
import { BULK_CHUNK_LIMIT, bulkAction, type BulkOutcome } from '@/lib/pipeline/feedback';
import { regenerateLearnedNotes } from '@/lib/pipeline/learning';
import { prisma, withDatabase } from '@/lib/prisma';

export const MAX_JOB_IDS = 5_000;

const ACTIVE = ['QUEUED', 'RUNNING'];

/** Finished jobs stay listed this long, for the "while you were away" note. */
const RECENT_MS = 24 * 3_600_000;
/** And are deleted after this long. */
const KEEP_MS = 7 * 86_400_000;

/** Jobs running at once, across all mailboxes. */
const MAX_PARALLEL = 3;

export type { JobDto };

export function serializeJob(job: Job, accountEmail: string | null = null): JobDto {
  return {
    id: job.id,
    accountId: job.accountId,
    accountEmail,
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

/**
 * Queue a LEARN job for one mailbox. Asking again while one is still waiting
 * or running returns that one rather than queueing a second.
 */
export async function enqueueLearn(accountId: string): Promise<Job> {
  const existing = await prisma.job.findFirst({
    where: { accountId, action: 'LEARN', status: { in: ACTIVE } },
  });
  if (existing) return existing;
  const job = await prisma.job.create({ data: { accountId, action: 'LEARN', total: 1 } });
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
  /** Jobs being worked on now. */
  inFlight: Set<string>;
  /** Mailboxes (or "all") with a job in flight; one job per mailbox at a time. */
  keys: Set<string>;
  scanning: boolean;
  /** Something changed while scanning; scan again. */
  again: boolean;
  booted: boolean;
}

const globalWorker = globalThis as unknown as { __automailJobs?: WorkerState };

function workerState(): WorkerState {
  globalWorker.__automailJobs ??= {
    inFlight: new Set(),
    keys: new Set(),
    scanning: false,
    again: false,
    booted: false,
  };
  return globalWorker.__automailJobs;
}

function keyOf(job: Pick<Job, 'accountId'>): string {
  return job.accountId ?? 'all';
}

/** Start whatever queued jobs can start now. Cheap to call often. */
export function kickJobs(): void {
  void fill(workerState());
}

async function fill(state: WorkerState): Promise<void> {
  if (state.scanning) {
    state.again = true;
    return;
  }
  state.scanning = true;
  try {
    do {
      state.again = false;
      if (state.inFlight.size >= MAX_PARALLEL) break;
      const waiting = await withDatabase(() =>
        prisma.job.findMany({
          where: { status: { in: ACTIVE }, id: { notIn: [...state.inFlight] } },
          orderBy: { createdAt: 'asc' },
        }),
      );
      if (!waiting.ok) break;
      for (const job of waiting.data) {
        if (state.inFlight.size >= MAX_PARALLEL) break;
        const key = keyOf(job);
        if (state.keys.has(key)) continue;
        state.keys.add(key);
        state.inFlight.add(job.id);
        void runJob(job).finally(() => {
          state.keys.delete(key);
          state.inFlight.delete(job.id);
          kickJobs();
        });
      }
    } while (state.again);
  } finally {
    state.scanning = false;
  }
}

/** Run one job to the end, and never let a broken one spin. */
async function runJob(job: Job): Promise<void> {
  try {
    if (job.action === 'LEARN') await learn(job);
    else await work(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[automail] job ${job.id} failed:`, message);
    await withDatabase(() =>
      prisma.job.updateMany({
        where: { id: job.id, status: { in: ACTIVE } },
        data: { status: 'DONE', finishedAt: new Date(), error: message, failed: Math.max(1, job.total - job.done) },
      }),
    );
    await release(job.id);
  }
}

async function learn(job: Job): Promise<void> {
  await prisma.job.update({ where: { id: job.id }, data: { status: 'RUNNING', startedAt: new Date() } });
  const result = job.accountId
    ? await regenerateLearnedNotes(job.accountId)
    : { ok: false, reason: 'No mailbox was given.' };
  await prisma.job.updateMany({
    where: { id: job.id, status: 'RUNNING' },
    data: {
      status: 'DONE',
      finishedAt: new Date(),
      done: result.ok ? 1 : 0,
      failed: result.ok ? 0 : 1,
      error: result.ok ? null : (result.reason ?? 'The notes could not be generated.'),
    },
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
      outcome = await bulkAction(slice, { action: job.action as BulkJobAction, category: job.category, note: job.note });
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
