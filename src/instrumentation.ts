/**
 * Next.js instrumentation hook: runs once when the server boots.
 * The scheduler is only started in the Node runtime (never in Edge or during
 * the build), and only after the database has had a chance to be created by
 * the container entrypoint.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { startScheduler } = await import('@/lib/scheduler');
  startScheduler();
}
