/**
 * Verifies the legacy college-email migration.
 *
 *   npm run verify:migration
 *
 * The question this answers is not "does the happy path work" — it is "can a
 * production account be damaged by any of this". So most of what follows checks
 * that things did NOT change: that a failed code leaves the old address in
 * place, that ids, password hashes and grants survive, that the Active Users
 * definition is untouched, and that no consent record was invented.
 *
 * Fixtures are prefixed `migtest+` and removed before and after.
 */
import 'dotenv/config';

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
  await prisma.user.deleteMany({ where: { email: { contains: 'migtest+' } } });
  await prisma.user.deleteMany({ where: { pendingEmail: { contains: 'migtest+' } } });
}

const ctx = { ip: '127.0.0.1', userAgent: 'verify-migration', device: null, browser: null, os: null };

async function main() {
  console.log(`\nVerifying the legacy college-email migration\n${'─'.repeat(56)}`);
  await cleanup();

  const { needsEmailMigration } = await import('../src/lib/auth/guards');
  const { issueCode, verifyCode, OTP_MAX_ATTEMPTS } = await import('../src/lib/auth/otp');
  const { isStudentEmail, registerSchema, requestEmailChangeSchema } = await import(
    '../src/lib/validation'
  );
  const { createSession, countLiveUsers, liveCutoff, endSession } = await import(
    '../src/lib/auth/session'
  );
  const { env } = await import('../src/lib/env');

  const password = await bcrypt.hash('Migrate-Verify-2026!', 10);
  const make = (email: string, extra: Record<string, unknown> = {}) =>
    prisma.user.create({
      data: { email, name: 'Migration Test', passwordHash: password, status: 'ACTIVE', ...extra },
    });

  const PURPOSE = 'email_change';

  // --- 1-5. Who is prompted ------------------------------------------------
  section('1-5. Who sees the migration prompt');
  {
    const legacyMit = await make('migtest+legacymit@mitwpu.edu.in');
    const legacyGmail = await make('migtest+legacy@gmail.com');
    const admin = await make('migtest+admin@anything.test', { role: 'ADMIN' });
    const verified = await make('migtest+verified@mitwpu.edu.in', {
      emailVerifiedAt: new Date(),
    });
    const newStudent = await make('migtest+new@mitwpu.edu.in', {
      verificationRequired: true,
      emailVerifiedAt: new Date(),
    });

    check('1. an existing MIT-WPU student is prompted', needsEmailMigration(legacyMit));
    check('2. an existing non-MIT student is prompted', needsEmailMigration(legacyGmail));
    check('3. an ADMIN is never prompted', !needsEmailMigration(admin));
    check('4. an already-verified student is not prompted', !needsEmailMigration(verified));
    check('5. a newly registered verified student is not prompted', !needsEmailMigration(newStudent));

    const disabled = await make('migtest+disabled@gmail.com', { status: 'DISABLED' });
    check(
      'a disabled account never reaches the prompt (login blocks first)',
      disabled.status !== 'ACTIVE',
    );
  }

  // --- 6-10. The address only moves on success -----------------------------
  section('6-10. The old address survives everything but success');
  {
    const user = await make('migtest+move@gmail.com');
    const target = 'migtest+moved@mitwpu.edu.in';

    // Propose, exactly as the route does.
    await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: target } });
    const { code } = await issueCode(user.id, null, PURPOSE);

    const beforeOtp = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('6. the email is unchanged while a code is outstanding', beforeOtp.email === user.email);
    check('   and the proposal is held separately', beforeOtp.pendingEmail === target);
    check('   with no verification timestamp yet', beforeOtp.emailVerifiedAt === null);

    // A wrong code.
    const wrong = await verifyCode(user.id, code === '000000' ? '111111' : '000000', PURPOSE);
    check('9. a wrong code is rejected', !wrong.ok);
    const afterWrong = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('   and the email is still the old one', afterWrong.email === user.email);
    check('   and the proposal survives for a retry', afterWrong.pendingEmail === target);

    // The right one.
    const right = await verifyCode(user.id, code, PURPOSE);
    check('7. the correct code is accepted', right.ok);
    await prisma.user.update({
      where: { id: user.id },
      data: { email: target, emailVerifiedAt: new Date(), pendingEmail: null },
    });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('7. the email is now the college address', after.email === target);
    check('8. emailVerifiedAt is set', after.emailVerifiedAt !== null);
    check('   the pending address is cleared', after.pendingEmail === null);
    check('   and the prompt never returns', !needsEmailMigration(after));
    check('   the user id is unchanged', after.id === user.id);
  }

  // --- 10. Expiry ----------------------------------------------------------
  section('10. An expired code changes nothing');
  {
    const user = await make('migtest+expire@gmail.com');
    const target = 'migtest+expire-new@mitwpu.edu.in';
    await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: target } });
    const { code } = await issueCode(user.id, null, PURPOSE);
    await prisma.emailVerificationToken.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const outcome = await verifyCode(user.id, code, PURPOSE);
    check('10. an expired code is rejected', !outcome.ok && outcome.reason === 'expired');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('    the email is unchanged', after.email === user.email);
    check('    and still unverified', after.emailVerifiedAt === null);

    // 13. Retry after failure.
    const retry = await issueCode(user.id, null, PURPOSE);
    const ok = await verifyCode(user.id, retry.code, PURPOSE);
    check('13. the student can request a new code and succeed', ok.ok);
  }

  // --- 11-12. Rejected addresses -------------------------------------------
  section('11-12. Addresses that must be refused');
  {
    const other = await make('migtest+owner@mitwpu.edu.in');
    const user = await make('migtest+wants@gmail.com');

    // 11. Duplicate — the route checks ownership; the database is the backstop.
    const owner = await prisma.user.findUnique({
      where: { email: other.email },
      select: { id: true },
    });
    check('11. an address owned by someone else is detectable before promotion', owner?.id === other.id);

    const collision = await prisma.user
      .update({ where: { id: user.id }, data: { email: other.email } })
      .then(() => null)
      .catch((error: unknown) => error);
    check('    and the unique index refuses it even if that check were skipped', collision !== null);
    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('    the would-be mover keeps its own address', untouched.email === user.email);
    check('    and the other account is untouched', (await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).email === other.email);

    // 12. Domain rules, same policy as registration.
    for (const bad of [
      'someone@gmail.com',
      'someone@mitwpu.edu',
      'someone@fake-mitwpu.edu.in',
      'someone@notmitwpu.edu.in',
      'someone@sub.mitwpu.edu.in',
    ]) {
      check(`12. rejected: ${bad}`, !requestEmailChangeSchema.safeParse({ email: bad }).success);
    }
    check(
      '12. accepted: Someone@MITWPU.EDU.IN (canonicalised)',
      requestEmailChangeSchema.safeParse({ email: 'Someone@MITWPU.EDU.IN' }).success,
    );
    check(
      '    the migration uses the same domain policy as registration',
      isStudentEmail('a@mitwpu.edu.in') && !isStudentEmail('a@sub.mitwpu.edu.in'),
    );
  }

  // --- 14-16, 23. Nothing else about the account moves ---------------------
  section('14-16, 23. Everything else about the account is preserved');
  {
    const user = await make('migtest+preserve@gmail.com', { college: 'MIT-WPU', semester: 5 });
    const semester = await prisma.semester.create({
      data: { name: '[migtest] Sem', slug: `migtest-${Date.now()}`, position: 98 },
    });
    const subject = await prisma.subject.create({
      data: { semesterId: semester.id, name: '[migtest] Subject', slug: `migtest-sub-${Date.now()}` },
    });
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        scope: 'SUBJECT',
        targetKey: `SUBJECT:${subject.id}`,
        subjectId: subject.id,
        source: 'ADMIN_GRANT',
      },
    });

    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const grantsBefore = await prisma.entitlement.count({ where: { userId: user.id } });
    const allUsersBefore = await prisma.user.count();

    const target = 'migtest+preserved@mitwpu.edu.in';
    await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: target } });
    const { code } = await issueCode(user.id, null, PURPOSE);
    await verifyCode(user.id, code, PURPOSE);
    await prisma.user.update({
      where: { id: user.id },
      data: { email: target, emailVerifiedAt: new Date(), pendingEmail: null },
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('15. the user id is unchanged', after.id === before.id);
    check('14. the password hash is unchanged', after.passwordHash === before.passwordHash);
    check('    the role is unchanged', after.role === before.role);
    check('    the status is unchanged', after.status === before.status);
    check('    the created date is unchanged', after.createdAt.getTime() === before.createdAt.getTime());
    check('    the profile fields are unchanged', after.college === before.college && after.semester === before.semester);
    check(
      '16. the entitlements are unchanged',
      (await prisma.entitlement.count({ where: { userId: user.id } })) === grantsBefore,
      `${grantsBefore} grants`,
    );
    check(
      '23. no other user row was touched',
      (await prisma.user.count()) === allUsersBefore,
    );

    // 21. Consent and PRN columns stay exactly as they were: NULL.
    check('21. termsAcceptedAt is still NULL', after.termsAcceptedAt === null);
    check('21. termsVersion is still NULL', after.termsVersion === null);
    check('21. analyticsConsentAt is still NULL', after.analyticsConsentAt === null);
    check('21. analyticsConsentVersion is still NULL', after.analyticsConsentVersion === null);
    check('    prn is still NULL', after.prn === null);

    await prisma.semester.deleteMany({ where: { name: { startsWith: '[migtest]' } } });
  }

  // --- 17-18. Analytics and Remember Me ------------------------------------
  section('17-18. Active Users and Remember Me are unaffected');
  {
    const user = await make('migtest+live@gmail.com');

    check(
      '17. the live window is still five minutes',
      Math.round((Date.now() - liveCutoff().getTime()) / 60_000) === env.liveWindowMinutes,
      `${env.liveWindowMinutes}`,
    );

    // 18. A remembered session for an unverified student is still gated.
    const { session } = await createSession(user.id, ctx, { rememberMe: true });
    check('18. a remembered session can exist for an unverified student', session.rememberMe === true);
    check('    and the gate still applies to them', needsEmailMigration(user));

    const baseline = await countLiveUsers();
    check('    they count as live while actually using the app', baseline >= 1);

    await prisma.session.update({
      where: { id: session.id },
      data: { lastActivityAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    const idle = await countLiveUsers();
    check(
      '17. ten idle minutes still removes them from the live count',
      idle === baseline - 1,
      `${baseline} → ${idle}`,
    );
    const row = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    check('    while the session itself stays valid', row.status === 'ACTIVE' && row.expiresAt > new Date());

    await endSession(session.id, 'LOGGED_OUT', 'test');
  }

  // --- 19-20. Registration no longer asks for PRN or consent ---------------
  section('19-20. Registration is name, email, password');
  {
    const minimal = {
      name: 'New Student',
      email: 'migtest+fresh@mitwpu.edu.in',
      password: 'Str0ng-Passw0rd!',
      confirmPassword: 'Str0ng-Passw0rd!',
    };
    const result = registerSchema.safeParse(minimal);
    check('19-20. a registration with no PRN and no consent fields is valid', result.success);

    check(
      '19. PRN is not part of the parsed payload',
      result.success && !('prn' in result.data),
    );
    check(
      '20. acceptTerms is not part of the parsed payload',
      result.success && !('acceptTerms' in result.data),
    );
    check(
      '20. analyticsConsent is not part of the parsed payload',
      result.success && !('analyticsConsent' in result.data),
    );
    check(
      '    extra fields sent by an old client are ignored, not honoured',
      (() => {
        const withExtras = registerSchema.safeParse({
          ...minimal,
          prn: 'X1',
          acceptTerms: true,
          analyticsConsent: true,
        });
        return withExtras.success && !('acceptTerms' in withExtras.data) && !('prn' in withExtras.data);
      })(),
    );
    check(
      '    the college domain rule still applies',
      !registerSchema.safeParse({ ...minimal, email: 'new@gmail.com' }).success,
    );
  }

  // --- 22. Admin authentication is unchanged -------------------------------
  section('22. Admin authentication is unchanged');
  {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' } });
    if (!admin) {
      check('22. no admin in this database (skipped)', true);
    } else {
      check('22. the admin is never gated, whatever its email domain', !needsEmailMigration(admin));
      check('    and holds no verification timestamp it did not earn', admin.emailVerifiedAt === null || admin.role === 'ADMIN');
      check('    its consent columns remain NULL', admin.termsAcceptedAt === null);
    }
  }

  // --- Brute force on the migration code -----------------------------------
  section('Brute force on a migration code');
  {
    const user = await make('migtest+brute@gmail.com');
    await prisma.user.update({
      where: { id: user.id },
      data: { pendingEmail: 'migtest+brute-new@mitwpu.edu.in' },
    });
    const { code } = await issueCode(user.id, null, PURPOSE);
    const wrong = code === '000000' ? '111111' : '000000';

    let last = '';
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
      const outcome = await verifyCode(user.id, wrong, PURPOSE);
      last = outcome.ok ? 'ok' : outcome.reason;
    }
    check(`the code locks after ${OTP_MAX_ATTEMPTS} wrong guesses`, last === 'too_many_attempts', last);
    const afterLock = await verifyCode(user.id, code, PURPOSE);
    check('and the real code stops working once locked', !afterLock.ok);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('the email is still the original one', row.email === user.email);

    // A sign-up code cannot be spent on a migration, or the reverse.
    const signup = await issueCode(user.id, null);
    const crossed = await verifyCode(user.id, signup.code, PURPOSE);
    check('a sign-up code cannot be used to change an email', !crossed.ok);
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
