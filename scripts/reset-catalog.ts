/**
 * Empties the academic catalogue — and nothing else.
 *
 *   npm run reset:catalog -- --yes
 *
 * Removes every semester, subject, unit, topic and note, and deletes the stored
 * PDF for each note and each retained note version. Use it to clear placeholder
 * or trial content before real material goes in.
 *
 * DELIBERATELY PRESERVED
 * ----------------------
 *   users            every account, password hash, role and status
 *   sessions         including the one you are signed in with
 *   entitlements     every grant that is not tied to a specific deleted note
 *   orders           the whole payment-ready table
 *   activity_events  the full analytics stream (note references become NULL)
 *   audit_logs       append-only, never touched
 *   settings         runtime configuration
 *   schema + migrations
 *
 * ONE UNAVOIDABLE CASCADE
 * -----------------------
 * `entitlements.noteId` is a foreign key with ON DELETE CASCADE, so a grant
 * written against one specific note disappears with that note. There is nothing
 * left for such a row to point at. Grants scoped to ALL / SEMESTER / SUBJECT /
 * UNIT survive untouched, and the script reports exactly how many note-scoped
 * grants (and note-view rows) went with the catalogue before it commits.
 *
 * The reset is written to the audit log as a CONFIG_CHANGED entry, so an empty
 * catalogue is never a mystery later.
 */
import 'dotenv/config';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const AUTO_CONFIRM = process.argv.includes('--yes') || process.env.RESET_CATALOG_YES === 'true';
const KEEP_FILES = process.argv.includes('--keep-files');

function row(label: string, value: number | string) {
  console.log(`  ${label.padEnd(22)}${value}`);
}

/** Deletes one stored object. Mirrors the app's storage drivers. */
async function deleteStoredObject(key: string): Promise<'deleted' | 'missing' | 'failed'> {
  const driver = process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local';

  if (driver === 'local') {
    const root = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR ?? './.private-storage');
    const target = path.resolve(root, key);
    // Same traversal guard the LocalStorageDriver applies.
    if (target !== root && !target.startsWith(root + path.sep)) return 'failed';
    try {
      await unlink(target);
      return 'deleted';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed';
    }
  }

  const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: process.env.S3_REGION ?? 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    },
  });
  try {
    await client.send(
      new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET ?? '', Key: key }),
    );
    return 'deleted';
  } catch {
    return 'failed';
  }
}

async function main() {
  const [semesters, subjects, units, topics, notes, versions] = await Promise.all([
    prisma.semester.count(),
    prisma.subject.count(),
    prisma.unit.count(),
    prisma.topic.count(),
    prisma.note.count(),
    prisma.noteVersion.count(),
  ]);

  const [users, entitlements, noteEntitlements, orders, events, audits, noteViews] =
    await Promise.all([
      prisma.user.count(),
      prisma.entitlement.count(),
      prisma.entitlement.count({ where: { noteId: { not: null } } }),
      prisma.order.count(),
      prisma.activityEvent.count(),
      prisma.auditLog.count(),
      prisma.noteView.count(),
    ]);

  console.log('\nCatalogue reset\n' + '─'.repeat(46));
  console.log('\nWill be deleted:');
  row('Semesters', semesters);
  row('Subjects', subjects);
  row('Units', units);
  row('Topics', topics);
  row('Notes', notes);
  row('Stored files', notes + versions);
  row('Note view records', noteViews);
  row('Note-scoped grants', `${noteEntitlements} (FK cascade)`);

  console.log('\nWill be kept:');
  row('Users', users);
  row('Other grants', entitlements - noteEntitlements);
  row('Orders', orders);
  row('Analytics events', events);
  row('Audit entries', audits);
  console.log('─'.repeat(46));

  if (semesters + subjects + units + topics + notes === 0) {
    console.log('\nThe catalogue is already empty. Nothing to do.\n');
    return;
  }

  if (!AUTO_CONFIRM) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question('\nType RESET to confirm: ');
    rl.close();
    if (answer.trim() !== 'RESET') {
      console.log('\nCancelled. Nothing was changed.\n');
      return;
    }
  }

  // 1. Collect every storage key before the rows go away.
  const keys = [
    ...(await prisma.note.findMany({ select: { storageKey: true } })).map((n) => n.storageKey),
    ...(await prisma.noteVersion.findMany({ select: { storageKey: true } })).map(
      (v) => v.storageKey,
    ),
  ];

  // 2. Delete the rows. Semester cascades through subject → unit → topic → note,
  //    and note cascades to note_versions, note_views and note-scoped grants.
  const deletedNotes = await prisma.note.deleteMany({});
  const deletedTopics = await prisma.topic.deleteMany({});
  const deletedUnits = await prisma.unit.deleteMany({});
  const deletedSubjects = await prisma.subject.deleteMany({});
  const deletedSemesters = await prisma.semester.deleteMany({});

  // 3. Remove the files themselves.
  let filesDeleted = 0;
  let filesMissing = 0;
  let filesFailed = 0;

  if (KEEP_FILES) {
    console.log(`\n--keep-files: leaving ${keys.length} stored file(s) in place.`);
  } else {
    for (const key of keys) {
      const outcome = await deleteStoredObject(key);
      if (outcome === 'deleted') filesDeleted += 1;
      else if (outcome === 'missing') filesMissing += 1;
      else filesFailed += 1;
    }
  }

  // 4. Record it. An empty catalogue should be explainable from the audit log.
  await prisma.auditLog.create({
    data: {
      action: 'CONFIG_CHANGED',
      actorEmail: process.env.USER ? `${process.env.USER} (cli)` : 'cli',
      targetType: 'Catalog',
      targetLabel: 'Catalogue reset',
      metadata: {
        script: 'reset-catalog',
        semesters: deletedSemesters.count,
        subjects: deletedSubjects.count,
        units: deletedUnits.count,
        topics: deletedTopics.count,
        notes: deletedNotes.count,
        filesDeleted,
        filesMissing,
        filesFailed,
        noteScopedGrantsRemoved: noteEntitlements,
      },
    },
  });

  const [usersAfter, entitlementsAfter, ordersAfter, eventsAfter, auditsAfter] = await Promise.all([
    prisma.user.count(),
    prisma.entitlement.count(),
    prisma.order.count(),
    prisma.activityEvent.count(),
    prisma.auditLog.count(),
  ]);

  console.log('\nDeleted:');
  row('Semesters', deletedSemesters.count);
  row('Subjects', deletedSubjects.count);
  row('Units', deletedUnits.count);
  row('Topics', deletedTopics.count);
  row('Notes', deletedNotes.count);
  if (!KEEP_FILES) {
    row('Files removed', filesDeleted);
    if (filesMissing) row('Files already gone', filesMissing);
    if (filesFailed) row('Files NOT removed', `${filesFailed} — check storage by hand`);
  }

  console.log('\nStill present:');
  row('Users', usersAfter);
  row('Grants', entitlementsAfter);
  row('Orders', ordersAfter);
  row('Analytics events', eventsAfter);
  row('Audit entries', `${auditsAfter} (+1 for this reset)`);
  console.log('─'.repeat(46));
  console.log('\nBuild the catalogue again in Admin → Notes.\n');
}

main()
  .catch((error) => {
    console.error('\nCatalogue reset failed:', error instanceof Error ? error.message : error);
    console.error('Nothing partial is left behind that the app cannot handle —');
    console.error('re-run the script to finish, or inspect the database directly.\n');
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
