/**
 * Checks that the live database actually matches the Prisma schema.
 *
 *   npm run db:verify
 *
 * It queries every model through Prisma (which selects every scalar column, so a
 * missing or renamed column fails immediately) and compares every enum's labels
 * against pg_enum. Useful after applying migrations by hand, and as a fast
 * post-deploy sanity check.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as Enums from '../src/generated/prisma/enums';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const MODELS = [
  'user',
  'session',
  'passwordResetToken',
  'rateLimit',
  'setting',
  'semester',
  'subject',
  'unit',
  'topic',
  'note',
  'noteVersion',
  'pyq',
  'entitlement',
  'order',
  'activityEvent',
  'noteView',
  'auditLog',
] as const;

async function main() {
  let failures = 0;

  console.log('Checking tables and columns…');
  for (const model of MODELS) {
    try {
      // findFirst with no select reads every scalar column of the model.
      const delegate = prisma[model] as unknown as { findFirst: () => Promise<unknown> };
      await delegate.findFirst();
      console.log(`  ✓ ${model}`);
    } catch (error) {
      failures += 1;
      console.error(`  ✗ ${model}: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
    }
  }

  console.log('\nChecking enums…');
  const enumRows = await prisma.$queryRaw<{ enum_name: string; labels: string }[]>`
    SELECT t.typname::text AS enum_name,
           string_agg(e.enumlabel::text, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
  `;
  const dbEnums = new Map(
    enumRows.map((row) => [row.enum_name, new Set(row.labels.split(','))]),
  );

  for (const [name, values] of Object.entries(Enums)) {
    if (typeof values !== 'object' || values === null) continue;
    const expected = Object.values(values as Record<string, string>);
    const actual = dbEnums.get(name);

    if (!actual) {
      failures += 1;
      console.error(`  ✗ ${name}: enum type missing from the database`);
      continue;
    }

    const missing = expected.filter((label) => !actual.has(label));
    if (missing.length > 0) {
      failures += 1;
      console.error(`  ✗ ${name}: missing labels ${missing.join(', ')}`);
    } else {
      console.log(`  ✓ ${name} (${expected.length} values)`);
    }
  }

  console.log('\nChecking indexes…');
  const indexes = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'
  `;
  console.log(`  ${indexes[0]?.count ?? 0} indexes present`);

  // One unit, one PDF. This is the rule the whole unit UI is built on, so it is
  // checked as a constraint in the database rather than trusted to the
  // application: a stray second note would otherwise only surface as a confusing
  // page. Checked by name because the index is what enforces it.
  console.log('\nChecking the one-note-per-unit rule…');
  const unique = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'notes' AND indexname = 'notes_unitId_key'
  `;
  if ((unique[0]?.count ?? 0) === 0) {
    failures += 1;
    console.error('  ✗ notes_unitId_key is missing — a unit could hold more than one note');
  } else {
    console.log('  ✓ notes_unitId_key (unique index on notes."unitId")');
  }

  const duplicates = await prisma.$queryRaw<{ unitId: string; notes: bigint }[]>`
    SELECT "unitId", COUNT(*) AS notes
    FROM "notes"
    WHERE "unitId" IS NOT NULL
    GROUP BY "unitId"
    HAVING COUNT(*) > 1
  `;
  if (duplicates.length > 0) {
    failures += 1;
    console.error(`  ✗ ${duplicates.length} unit(s) hold more than one note`);
  } else {
    console.log('  ✓ no unit holds more than one note');
  }

  if (failures > 0) {
    console.error(`\n${failures} problem(s) found. Run \`npm run db:setup\` (or \`npx prisma migrate dev\`).`);
    process.exit(1);
  }

  console.log('\nDatabase matches the Prisma schema.\n');
}

main()
  .catch((error) => {
    console.error('Verification failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
