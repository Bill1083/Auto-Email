import { PrismaClient } from '@prisma/client';

/**
 * A single Prisma client per process.
 *
 * Next.js hot-reloads server modules in development, which would otherwise
 * open a new SQLite connection on every edit until the pool is exhausted.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Persistence is a convenience here, not a hard requirement: an unwritable or
 * unmigrated database should degrade to a stateless session rather than break
 * an upload. Callers use this to keep going when a write fails.
 */
export async function withDatabase<T>(
  operation: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown database error';
    console.error('[automail] database operation failed:', message);
    return { ok: false, error: message };
  }
}

/**
 * True when the database is both reachable and migrated.
 *
 * A bare `SELECT 1` is not enough: SQLite happily opens an empty file, so a
 * connectivity-only probe reports success for a database with no tables, and
 * every write then fails. Querying a real table proves the schema is applied.
 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1 FROM accounts LIMIT 1`;
    return true;
  } catch {
    return false;
  }
}
