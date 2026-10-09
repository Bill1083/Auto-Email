import { describe, expect, it } from 'vitest';

import { jobPercent, jobSummary, type JobProgressLike } from '@/lib/job-text';
import { forEachConcurrent } from '@/lib/utils';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('forEachConcurrent', () => {
  it('visits every item, never with more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachConcurrent(
      Array.from({ length: 40 }, (_, i) => i),
      6,
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(item % 3);
        seen.push(item);
        inFlight -= 1;
      },
    );
    expect(peak).toBe(6);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('is much faster than one at a time when each call waits on the network', async () => {
    const started = Date.now();
    await forEachConcurrent(Array.from({ length: 12 }), 6, () => sleep(30));
    // Sequential would be ~360ms; six at a time is two rounds.
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('stops starting new work after a failure, lets the rest finish, then throws', async () => {
    const started: number[] = [];
    let finished = 0;
    await expect(
      forEachConcurrent(
        Array.from({ length: 20 }, (_, i) => i),
        3,
        async (item) => {
          started.push(item);
          if (item === 1) throw new Error('reconnect');
          await sleep(5);
          finished += 1;
        },
      ),
    ).rejects.toThrow('reconnect');
    expect(started.length).toBeLessThan(20);
    // Everything that started (bar the one that threw) ran to the end.
    expect(finished).toBe(started.length - 1);
  });

  it('copes with an empty list', async () => {
    await expect(forEachConcurrent([], 4, async () => undefined)).resolves.toBeUndefined();
  });
});

describe('job wording', () => {
  const base: JobProgressLike = { action: 'TRASH', status: 'DONE', total: 512, done: 512, failed: 0, error: null };

  it('summarises a clean run', () => {
    expect(jobSummary(base)).toBe('512 emails moved to Trash.');
    expect(jobSummary({ ...base, total: 1, done: 1 })).toBe('1 email moved to Trash.');
  });

  it('says what failed and that it went back to the queue', () => {
    expect(jobSummary({ ...base, done: 500, failed: 12, error: 'Account needs to be reconnected.' })).toBe(
      '500 of 512 emails moved to Trash; 12 could not be and are back in the queue: Account needs to be reconnected.',
    );
    expect(jobSummary({ ...base, done: 0, failed: 512, error: 'Gemini is still busy.' })).toBe(
      'None of the 512 emails could be moved: Gemini is still busy.',
    );
  });

  it('describes a cancelled job', () => {
    expect(jobSummary({ ...base, status: 'CANCELLED', done: 120, failed: 0 })).toBe(
      'Stopped: 120 emails moved to Trash before you cancelled; the other 392 are back in the queue.',
    );
  });

  it('counts failures as progress so the bar always reaches the end', () => {
    expect(jobPercent({ total: 200, done: 50, failed: 50 })).toBe(50);
    expect(jobPercent({ total: 0, done: 0, failed: 0 })).toBe(100);
  });
});
