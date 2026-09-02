/**
 * Applies the SQL files in prisma/migrations to the database and records them in
 * Prisma's own `_prisma_migrations` table, exactly the way `prisma migrate deploy`
 * would.
 *
 * Why this exists: `prisma migrate deploy` needs Prisma's schema engine binary,
 * which is downloaded from Prisma's CDN. This script only needs a Postgres
 * connection, so `npm run db:setup` works on locked-down networks, in CI images
 * without the engine, and inside minimal containers. Running
 * `prisma migrate deploy` afterwards is still safe — it sees the migrations as
 * already applied.
 */
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.join(process.cwd(), 'prisma', 'migrations');

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                    VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum"              VARCHAR(64) NOT NULL,
  "finished_at"           TIMESTAMPTZ,
  "migration_name"        VARCHAR(255) NOT NULL,
  "logs"                  TEXT,
  "rolled_back_at"        TIMESTAMPTZ,
  "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
);`;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(CREATE_MIGRATIONS_TABLE);

    const applied = await client.query<{ migration_name: string; finished_at: Date | null }>(
      'SELECT migration_name, finished_at FROM "_prisma_migrations"',
    );
    const appliedNames = new Set(
      applied.rows.filter((r) => r.finished_at !== null).map((r) => r.migration_name),
    );

    const entries = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    if (entries.length === 0) {
      console.log('No migrations found.');
      return;
    }

    let ran = 0;
    for (const name of entries) {
      if (appliedNames.has(name)) {
        console.log(`  ✓ ${name} (already applied)`);
        continue;
      }

      const sqlPath = path.join(MIGRATIONS_DIR, name, 'migration.sql');
      const sql = await readFile(sqlPath, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      process.stdout.write(`  → ${name} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO "_prisma_migrations"
             (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
           VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
          [randomUUID(), checksum, name],
        );
        await client.query('COMMIT');
        ran += 1;
        console.log('applied');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('failed');
        throw err;
      }
    }

    console.log(
      ran === 0
        ? 'Database already up to date.'
        : `Applied ${ran} migration${ran === 1 ? '' : 's'}.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
