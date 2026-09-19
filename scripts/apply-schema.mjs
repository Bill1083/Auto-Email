/**
 * Applies the SQLite schema on container start.
 *
 * The Prisma CLI is not usable inside the Next.js standalone bundle: standalone
 * traces only what the app imports, so the CLI's own dependency tree (`effect`
 * and friends) is absent, and shipping it would add tens of megabytes purely to
 * run one DDL statement set.
 *
 * Instead the build emits `prisma/schema.sql` via `prisma migrate diff`, and
 * this script applies it through the Prisma client that the app already ships.
 *
 * Idempotent: if the tables are already there, it exits without touching them,
 * so it is safe on every boot.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_SQL = path.join(process.cwd(), 'prisma', 'schema.sql');

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ log: ['error'] });

  try {
    // Probing a real table distinguishes "already migrated" from the empty
    // file SQLite creates on connect.
    await prisma.$queryRaw`SELECT 1 FROM accounts LIMIT 1`;
    console.log('[automail] schema already present, nothing to apply');
    return;
  } catch {
    console.log('[automail] no schema found, applying prisma/schema.sql');
  }

  let sql;
  try {
    sql = readFileSync(SCHEMA_SQL, 'utf8');
  } catch {
    throw new Error(`Could not read ${SCHEMA_SQL}. Was it generated at build time?`);
  }

  const statements = sql
    .split(';')
    .map((statement) =>
      statement
        // Drop the `-- CreateTable` comments prisma emits.
        .replace(/^\s*--.*$/gm, '')
        .trim(),
    )
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }

  console.log(`[automail] applied ${statements.length} statements`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('[automail] schema apply failed:', error?.message ?? error);
  process.exit(1);
});
