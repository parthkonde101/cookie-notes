/**
 * Seed.
 *
 * Cookie Notes deliberately ships with an **empty catalogue**. Your academic
 * structure is your own — semesters, subjects, units, topics and notes are
 * created in Admin → Notes, and the empty state there walks you through it.
 *
 * Seeding demo semesters would mean deleting them again before launch, and worse,
 * would put content in the public catalogue that nobody wrote. So this script
 * creates nothing. It exists to confirm the database is reachable, migrated and
 * ready, and to tell you what to do next.
 *
 * If you ever want fixtures for local development, add them behind an explicit
 * flag (e.g. `SEED_DEMO=true`) so they can never reach production by accident.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const [admins, students, semesters, subjects, notes] = await Promise.all([
    prisma.user.count({ where: { role: 'ADMIN' } }),
    prisma.user.count({ where: { role: 'STUDENT' } }),
    prisma.semester.count(),
    prisma.subject.count(),
    prisma.note.count(),
  ]);

  console.log('\nCookie Notes — database status\n' + '─'.repeat(34));
  console.log(`  Admins      ${admins}`);
  console.log(`  Students    ${students}`);
  console.log(`  Semesters   ${semesters}`);
  console.log(`  Subjects    ${subjects}`);
  console.log(`  Notes       ${notes}`);
  console.log('─'.repeat(34));

  console.log('\nNo demo content is created — the catalogue is yours to build.\n');

  const steps: string[] = [];
  if (admins === 0) steps.push('Create your admin account:   npm run create:admin');
  if (semesters === 0) steps.push('Add your first semester:     Admin → Notes → Semester');
  else if (subjects === 0) steps.push('Add your first subject:      Admin → Notes → Subject');
  else if (notes === 0) steps.push('Upload your first note:      Admin → Notes → Upload note');

  if (steps.length > 0) {
    console.log('Next:');
    for (const step of steps) console.log(`  • ${step}`);
    console.log('');
  } else {
    console.log('Everything is set up. Visit / to see the catalogue.\n');
  }
}

main()
  .catch((error) => {
    console.error('Could not reach the database:', error instanceof Error ? error.message : error);
    console.error('\nCheck DATABASE_URL in .env, then run `npm run db:setup`.\n');
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
