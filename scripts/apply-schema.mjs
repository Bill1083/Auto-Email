/**
 * Applies the SQLite schema, then any data migrations, on container start.
 *
 * The Prisma CLI is not usable inside the Next.js standalone bundle: standalone
 * traces only what the app imports, so the CLI's own dependency tree (`effect`
 * and friends) is absent, and shipping it would add tens of megabytes purely to
 * run one DDL statement set.
 *
 * Instead the build emits `prisma/schema.sql` via `prisma migrate diff`, and
 * this script applies it through the Prisma client that the app already ships.
 *
 * On a fresh volume it creates every table. On an existing volume it leaves
 * the tables alone and runs the migrations below. Each migration checks the
 * database's actual state before doing anything, so this whole script is safe
 * on every boot and a migration runs exactly once.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_SQL = path.join(process.cwd(), 'prisma', 'schema.sql');

async function tableExists(prisma, name) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
  );
  return rows.length > 0;
}

async function columnNames(prisma, table) {
  const rows = await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
  return new Set(rows.map((row) => row.name));
}

async function count(prisma, sql) {
  const rows = await prisma.$queryRawUnsafe(sql);
  // SQLite COUNT(*) comes back as a BigInt through Prisma.
  return Number(rows[0]?.n ?? 0);
}

async function applyFreshSchema(prisma) {
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
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Settings gained a `scope` column, and the primary key became (scope, key).
 * SQLite cannot alter a primary key in place, so the table is rebuilt with
 * Prisma's exact DDL and every existing row is kept, as "global" for now.
 */
async function addSettingsScope(prisma) {
  const columns = await columnNames(prisma, 'settings');
  if (columns.has('scope')) return false;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE TABLE "settings_new" (
    "scope" TEXT NOT NULL DEFAULT 'global',
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("scope", "key")
)`);
    await tx.$executeRawUnsafe(
      `INSERT INTO "settings_new" ("scope", "key", "value", "updatedAt")
       SELECT 'global', "key", "value", "updatedAt" FROM "settings"`,
    );
    await tx.$executeRawUnsafe(`DROP TABLE "settings"`);
    await tx.$executeRawUnsafe(`ALTER TABLE "settings_new" RENAME TO "settings"`);
  });
  return true;
}

/**
 * Every setting now belongs to one mailbox. Shared rows written by earlier
 * versions are copied onto each existing mailbox, so nothing that was
 * configured is lost, and from then on each copy is edited independently.
 * A mailbox's own daily-cap override was the most specific value there was,
 * so it wins over the copied shared cap.
 *
 * Global rows that are not settings (the demo mailbox's fixture state, keyed
 * `mock:`) stay where they are. With no mailbox connected yet there is
 * nothing to copy onto, so the rows are left for a later boot.
 */
async function moveSettingsOntoMailboxes(prisma) {
  const accounts = await count(prisma, `SELECT COUNT(*) AS n FROM "accounts"`);
  if (accounts === 0) return false;

  const shared = await count(
    prisma,
    `SELECT COUNT(*) AS n FROM "settings" WHERE "scope" = 'global' AND "key" NOT LIKE 'mock:%'`,
  );
  const capOverrides = await count(
    prisma,
    `SELECT COUNT(*) AS n FROM "accounts" WHERE "dailyLimit" IS NOT NULL`,
  );
  if (shared === 0 && capOverrides === 0) return false;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "settings" ("scope", "key", "value", "updatedAt")
       SELECT a."id", s."key", s."value", s."updatedAt"
       FROM "settings" s CROSS JOIN "accounts" a
       WHERE s."scope" = 'global' AND s."key" NOT LIKE 'mock:%'`,
    );
    await tx.$executeRawUnsafe(
      `INSERT OR REPLACE INTO "settings" ("scope", "key", "value", "updatedAt")
       SELECT "id", 'dailyLimit', CAST("dailyLimit" AS TEXT), "updatedAt"
       FROM "accounts" WHERE "dailyLimit" IS NOT NULL`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "settings" WHERE "scope" = 'global' AND "key" NOT LIKE 'mock:%'`,
    );
    await tx.$executeRawUnsafe(
      `UPDATE "accounts" SET "dailyLimit" = NULL WHERE "dailyLimit" IS NOT NULL`,
    );
  });
  return true;
}

// ---------------------------------------------------------------------------

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ log: ['error'] });

  try {
    // Checking sqlite_master rather than querying a table keeps a fresh boot
    // from logging a Prisma error for a table that simply is not there yet.
    if (await tableExists(prisma, 'accounts')) {
      console.log('[automail] schema already present, checking migrations');
    } else {
      console.log('[automail] no schema found, applying prisma/schema.sql');
      await applyFreshSchema(prisma);
    }

    if (await addSettingsScope(prisma)) {
      console.log('[automail] migrated: settings table now scoped per mailbox');
    }
    if (await moveSettingsOntoMailboxes(prisma)) {
      console.log('[automail] migrated: shared settings copied onto each mailbox');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[automail] schema apply failed:', error?.message ?? error);
  process.exit(1);
});
