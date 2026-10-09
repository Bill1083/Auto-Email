/**
 * Next.js instrumentation hook: runs once when the server boots.
 * The scheduler and the background job worker are only started in the Node runtime (never in Edge or during
 * the build), and only after the database has had a chance to be created by
 * the container entrypoint.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { startScheduler } = await import('@/lib/scheduler');
  startScheduler();
  // Bulk actions queued before a restart carry on where they stopped.
  const { startJobWorker } = await import('@/lib/jobs');
  await startJobWorker();
}
