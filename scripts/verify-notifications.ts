/**
 * Verifies the note-ready notification engine.
 *
 *   npm run verify:notifications
 *
 * These run in-process against a real database rather than through HTTP,
 * because what needs proving is who *would* be emailed and exactly once — and
 * the `note_notifications` table is the ground truth for that. A row exists per
 * recipient per upload event, so "did this person get one email or two" is a
 * count, not an inspection of a mailbox.
 *
 * The mail-failure case deliberately points the Resend driver at an
 * unreachable host: the point is that the note stays published and the failure
 * lands on the notification rows, not on the upload.
 *
 * Test fixtures are prefixed `[notify]` and removed before and after each run.
 */
import 'dotenv/config';

// The mail and storage modules are marked `server-only`, which throws outside a
// React Server Component. Neutralise the marker before importing them.
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = {
  id: serverOnly,
  filename: serverOnly,
  loaded: true,
  exports: {},
} as NodeJS.Module;

import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const PREFIX = '[notify]';
const ctx = {
  ip: '127.0.0.1',
  userAgent: 'verify-notifications',
  device: null,
  browser: null,
  os: null,
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function cleanup() {
  await prisma.user.deleteMany({ where: { email: { contains: 'notifytest+' } } });
  await prisma.subject.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.semester.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

/** Who actually has a notification row for this event, and in what state. */
async function recipientsFor(eventKey: string) {
  const rows = await prisma.noteNotification.findMany({
    where: { eventKey },
    select: { userId: true, status: true, viaSubscription: true, user: { select: { email: true } } },
  });
  return {
    total: rows.length,
    sent: rows.filter((r) => r.status === 'SENT').length,
    failed: rows.filter((r) => r.status === 'FAILED').length,
    emails: new Set(rows.map((r) => r.user.email)),
    rows,
  };
}

async function main() {
  console.log(`\nVerifying note-ready notifications\n${'─'.repeat(56)}`);
  await cleanup();

  const { notifyNoteReady, noteReadyEventKey } = await import('../src/lib/notes/notifications');

  // --- fixtures ------------------------------------------------------------
  const password = await bcrypt.hash('Notify-Verify-2026!', 10);
  const admin = await prisma.user.create({
    data: {
      email: 'notifytest+admin@cookienotes.test',
      name: 'Notify Admin',
      passwordHash: password,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  const subscriber = await prisma.user.create({
    data: {
      email: 'notifytest+subscriber@cookienotes.test',
      name: 'Subscriber',
      passwordHash: password,
      status: 'ACTIVE',
    },
  });
  const bystander = await prisma.user.create({
    data: {
      email: 'notifytest+bystander@cookienotes.test',
      name: 'Bystander',
      passwordHash: password,
      status: 'ACTIVE',
    },
  });
  const disabled = await prisma.user.create({
    data: {
      email: 'notifytest+disabled@cookienotes.test',
      name: 'Disabled',
      passwordHash: password,
      status: 'DISABLED',
    },
  });

  const semester = await prisma.semester.create({
    data: { name: `${PREFIX} Semester`, slug: `notify-sem-${Date.now()}`, position: 95 },
  });
  const subject = await prisma.subject.create({
    data: {
      semesterId: semester.id,
      name: `${PREFIX} Subject`,
      slug: `notify-sub-${Date.now()}`,
    },
  });

  const makeUnit = (name: string, position: number) =>
    prisma.unit.create({ data: { subjectId: subject.id, name, position } });

  const makeNote = async (unitId: string, title: string) => {
    const note = await prisma.note.create({
      data: {
        title,
        subjectId: subject.id,
        unitId,
        status: 'PUBLISHED',
        visibility: 'FREE',
        storageKey: `notes/verify/${unitId}.pdf`,
        fileName: 'verify.pdf',
        fileSize: 1024,
        publishedAt: new Date(),
        versions: {
          create: { version: 1, storageKey: `notes/verify/${unitId}.pdf`, fileName: 'verify.pdf', fileSize: 1024 },
        },
      },
      select: { id: true, versions: { select: { id: true } } },
    });
    return { id: note.id, versionId: note.versions[0]!.id };
  };

  // --- 1. subscribers only -------------------------------------------------
  section('1. Upload without "Notify all" — subscribers only');
  {
    const unit = await makeUnit(`${PREFIX} Unit 1`, 0);
    await prisma.unitNotificationSubscription.create({
      data: { userId: subscriber.id, unitId: unit.id },
    });
    const note = await makeNote(unit.id, `${PREFIX} Unit 1`);

    const result = await notifyNoteReady({
      unitId: unit.id,
      noteId: note.id,
      noteVersionId: note.versionId,
      notifyAll: false,
      notifySubscribers: true,
      actor: admin,
      ctx,
    });

    const recipients = await recipientsFor(result.eventKey);
    check('exactly one recipient', recipients.total === 1, `${recipients.total}`);
    check('it is the subscriber', recipients.emails.has(subscriber.email));
    check('the bystander is not notified', !recipients.emails.has(bystander.email));
    check('the email was recorded as sent', recipients.sent === 1);
    check('and is marked as coming from a subscription', recipients.rows[0]?.viaSubscription === true);
  }

  // --- 2. notify all -------------------------------------------------------
  section('2. Upload with "Notify all" — every eligible user, once each');
  {
    const unit = await makeUnit(`${PREFIX} Unit 2`, 1);
    // The subscriber is ALSO in the broadcast list: this is the deduplication
    // case — subscriber + notify all must still be exactly one email.
    await prisma.unitNotificationSubscription.create({
      data: { userId: subscriber.id, unitId: unit.id },
    });
    const note = await makeNote(unit.id, `${PREFIX} Unit 2`);

    const result = await notifyNoteReady({
      unitId: unit.id,
      noteId: note.id,
      noteVersionId: note.versionId,
      notifyAll: true,
      notifySubscribers: true,
      actor: admin,
      ctx,
    });

    const recipients = await recipientsFor(result.eventKey);
    const activeUsers = await prisma.user.count({ where: { status: 'ACTIVE', deletedAt: null } });

    check('every active user is notified', recipients.total === activeUsers, `${recipients.total} of ${activeUsers}`);
    check('the subscriber appears exactly once', [...recipients.rows].filter((r) => r.userId === subscriber.id).length === 1);
    check('the bystander is notified', recipients.emails.has(bystander.email));
    check('a disabled account is NOT notified', !recipients.emails.has(disabled.email));
    check('the subscriber row is still flagged as a subscription', recipients.rows.find((r) => r.userId === subscriber.id)?.viaSubscription === true);
  }

  // --- 3. retry is a no-op -------------------------------------------------
  section('3. A retry of the same upload event sends nothing again');
  {
    const unit = await makeUnit(`${PREFIX} Unit 3`, 2);
    await prisma.unitNotificationSubscription.create({
      data: { userId: subscriber.id, unitId: unit.id },
    });
    const note = await makeNote(unit.id, `${PREFIX} Unit 3`);
    const args = {
      unitId: unit.id,
      noteId: note.id,
      noteVersionId: note.versionId,
      notifyAll: true,
      notifySubscribers: true,
      actor: admin,
      ctx,
    };

    const first = await notifyNoteReady(args);
    const before = await recipientsFor(first.eventKey);

    const second = await notifyNoteReady(args);
    const after = await recipientsFor(first.eventKey);

    check('the first dispatch sent mail', first.sent > 0, `${first.sent}`);
    check('the retry reports it was already dispatched', second.alreadyDispatched === true);
    check('the retry sent nothing', second.sent === 0, `${second.sent}`);
    check('and created no extra recipient rows', after.total === before.total, `${before.total} → ${after.total}`);
    check('the event key is stable across retries', first.eventKey === second.eventKey);
    check(
      'the key names the unit and the note version',
      first.eventKey === noteReadyEventKey(unit.id, note.versionId),
      first.eventKey,
    );
  }

  // --- 4. replacement ------------------------------------------------------
  section('4. Replacing an existing PDF');
  {
    const unit = await makeUnit(`${PREFIX} Unit 4`, 3);
    await prisma.unitNotificationSubscription.create({
      data: { userId: subscriber.id, unitId: unit.id },
    });
    const note = await makeNote(unit.id, `${PREFIX} Unit 4`);

    // First upload notifies the subscriber.
    await notifyNoteReady({
      unitId: unit.id,
      noteId: note.id,
      noteVersionId: note.versionId,
      notifyAll: false,
      notifySubscribers: true,
      actor: admin,
      ctx,
    });

    // A replacement creates a new version — a new event key.
    const v2 = await prisma.noteVersion.create({
      data: { noteId: note.id, version: 2, storageKey: 'notes/verify/v2.pdf', fileName: 'v2.pdf', fileSize: 2048 },
      select: { id: true },
    });

    const quiet = await notifyNoteReady({
      unitId: unit.id,
      noteId: note.id,
      noteVersionId: v2.id,
      notifyAll: false,
      // This is what the upload route passes for a replacement.
      notifySubscribers: false,
      actor: admin,
      ctx,
    });
    check('a plain replacement notifies nobody', quiet.attempted === 0, `${quiet.attempted}`);
    check('and writes no recipient rows', (await recipientsFor(quiet.eventKey)).total === 0);

    // …unless the admin explicitly ticks "Notify all".
    const v3 = await prisma.noteVersion.create({
      data: { noteId: note.id, version: 3, storageKey: 'notes/verify/v3.pdf', fileName: 'v3.pdf', fileSize: 3072 },
      select: { id: true },
    });
    const loud = await notifyNoteReady({
      unitId: unit.id,
      noteId: note.id,
      noteVersionId: v3.id,
      notifyAll: true,
      notifySubscribers: false,
      actor: admin,
      ctx,
    });
    const recipients = await recipientsFor(loud.eventKey);
    const activeUsers = await prisma.user.count({ where: { status: 'ACTIVE', deletedAt: null } });
    check('a replacement with "Notify all" does notify', loud.sent > 0, `${loud.sent}`);
    check('and reaches every active user once', recipients.total === activeUsers, `${recipients.total} of ${activeUsers}`);
  }

  // --- 5. nobody to notify -------------------------------------------------
  section('5. No subscribers and no broadcast');
  {
    const unit = await makeUnit(`${PREFIX} Unit 5`, 4);
    const note = await makeNote(unit.id, `${PREFIX} Unit 5`);
    const result = await notifyNoteReady({
      unitId: unit.id,
      noteId: note.id,
      noteVersionId: note.versionId,
      notifyAll: false,
      notifySubscribers: true,
      actor: admin,
      ctx,
    });
    check('zero emails', result.sent === 0 && result.attempted === 0);
    check('and zero rows written', (await recipientsFor(result.eventKey)).total === 0);
  }

  // --- 6. the mail provider fails -----------------------------------------
  section('6. The email provider fails');
  {
    const unit = await makeUnit(`${PREFIX} Unit 6`, 5);
    await prisma.unitNotificationSubscription.create({
      data: { userId: subscriber.id, unitId: unit.id },
    });
    const note = await makeNote(unit.id, `${PREFIX} Unit 6`);

    // Point the driver at a host that cannot answer. `env` reads process.env
    // lazily, so this takes effect for this call only.
    const previousDriver = process.env.MAIL_DRIVER;
    const previousKey = process.env.RESEND_API_KEY;
    process.env.MAIL_DRIVER = 'resend';
    process.env.RESEND_API_KEY = 're_verify_invalid_key';

    let threw = false;
    let result: Awaited<ReturnType<typeof notifyNoteReady>> | null = null;
    try {
      result = await notifyNoteReady({
        unitId: unit.id,
        noteId: note.id,
        noteVersionId: note.versionId,
        notifyAll: false,
        notifySubscribers: true,
        actor: admin,
        ctx,
      });
    } catch {
      threw = true;
    } finally {
      process.env.MAIL_DRIVER = previousDriver;
      process.env.RESEND_API_KEY = previousKey;
    }

    check('the dispatcher does not throw', !threw);
    check('the failure is reported, not swallowed', (result?.failed ?? 0) > 0, `${result?.failed} failed`);
    check('nothing is reported as sent', result?.sent === 0);

    const recipients = await recipientsFor(result?.eventKey ?? '');
    check('the recipient row records the failure', recipients.failed === 1, `${recipients.failed}`);
    check('with an error message attached', Boolean(recipients.rows[0] && 'status' in recipients.rows[0]));

    // The whole point: the note is untouched by a mail problem.
    const stillThere = await prisma.note.findUnique({
      where: { id: note.id },
      select: { id: true, status: true },
    });
    check('the note is still published', stillThere?.status === 'PUBLISHED');
  }

  // --- 7. the invariant ----------------------------------------------------
  section('7. Being Baked never coexists with a PDF');
  {
    const unit = await prisma.unit.create({
      data: { subjectId: subject.id, name: `${PREFIX} Unit 7`, position: 6, beingBaked: true },
    });
    check('a unit with no PDF can be flagged', (await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })).beingBaked === true);

    // Mirrors what the upload route does, in one transaction.
    await prisma.$transaction(async (tx) => {
      await tx.note.create({
        data: {
          title: `${PREFIX} Unit 7`,
          subjectId: subject.id,
          unitId: unit.id,
          status: 'PUBLISHED',
          visibility: 'FREE',
          storageKey: `notes/verify/${unit.id}.pdf`,
          fileName: 'verify.pdf',
          fileSize: 512,
        },
      });
      await tx.unit.update({ where: { id: unit.id }, data: { beingBaked: false } });
    });

    const after = await prisma.unit.findUniqueOrThrow({
      where: { id: unit.id },
      select: { beingBaked: true, notes: { select: { id: true } } },
    });
    check('uploading a PDF clears the flag server-side', after.beingBaked === false);
    check('the unit does have its PDF', after.notes.length === 1);

    const violations = await prisma.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM "units" u
      WHERE u."beingBaked" = true
        AND EXISTS (SELECT 1 FROM "notes" n WHERE n."unitId" = u.id)
    `;
    check('no unit anywhere is baking with a PDF', violations.length === 0, `${violations.length}`);
  }

  // --- 8. subscription uniqueness -----------------------------------------
  section('8. One subscription per student per unit');
  {
    const unit = await makeUnit(`${PREFIX} Unit 8`, 7);
    await prisma.unitNotificationSubscription.create({
      data: { userId: subscriber.id, unitId: unit.id },
    });

    const duplicate = await prisma.unitNotificationSubscription
      .create({ data: { userId: subscriber.id, unitId: unit.id } })
      .then(() => null)
      .catch((error: unknown) => error);
    check('a duplicate subscription is rejected by the database', duplicate !== null);

    const count = await prisma.unitNotificationSubscription.count({ where: { unitId: unit.id } });
    check('the subscriber count is right', count === 1, `${count}`);
  }

  console.log(`\n${'─'.repeat(56)}`);
  if (failed === 0) {
    console.log(`\x1b[32m${passed} checks passed.\x1b[0m\n`);
  } else {
    console.log(`\x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m:`);
    for (const name of failures) console.log(`  • ${name}`);
    console.log('');
  }

  await cleanup();
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nVerification crashed:', error);
  await cleanup().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
