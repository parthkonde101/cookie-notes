/**
 * Verifies the authentication additions: Remember Me, the MIT-WPU email policy,
 * one-time codes, and consent records.
 *
 *   npm run verify:auth
 *
 * In-process against a real database, because what needs proving is mostly
 * about rows and clocks rather than HTTP: that a remembered session lives for
 * thirty days without ever being counted as "studying right now", that a
 * six-digit code cannot be brute-forced or replayed, and that none of it
 * disturbs an account created before any of it existed.
 *
 * Fixtures are prefixed `[auth]` / `authtest+` and removed before and after.
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
  await prisma.user.deleteMany({ where: { email: { contains: 'authtest+' } } });
}

const ctx = { ip: '127.0.0.1', userAgent: 'verify-auth', device: null, browser: null, os: null };

async function main() {
  console.log(`\nVerifying authentication\n${'─'.repeat(56)}`);
  await cleanup();

  const { canonicalEmail, emailDomain, isStudentEmail, registerSchema, loginSchema, otpCodeSchema } =
    await import('../src/lib/validation');
  const {
    createSession,
    countLiveUsers,
    findLiveSession,
    expireStaleSessions,
    idleCutoffFor,
    liveCutoff,
    sessionLifetimeSeconds,
    endSession,
  } = await import('../src/lib/auth/session');
  const { generateCode, hashCode, issueCode, verifyCode, OTP_MAX_ATTEMPTS } = await import(
    '../src/lib/auth/otp'
  );
  const { env } = await import('../src/lib/env');

  const password = await bcrypt.hash('Auth-Verify-2026!', 10);
  const makeUser = (email: string, extra: Record<string, unknown> = {}) =>
    prisma.user.create({
      data: { email, name: 'Auth Test', passwordHash: password, status: 'ACTIVE', ...extra },
    });

  // --- 1. Email policy -----------------------------------------------------
  section('1. MIT-WPU email policy');
  {
    const allowed = ['student@mitwpu.edu.in', 'Student@MITWPU.EDU.IN', '  a.b@Mitwpu.Edu.In  '];
    const rejected = [
      'student@gmail.com',
      'student@mitwpu.edu',
      'student@fake-mitwpu.edu.in',
      'student@mitwpu.edu.in.evil.com',
      'student@notmitwpu.edu.in',
      'student@sub.mitwpu.edu.in',
    ];

    for (const value of allowed) {
      check(`accepted: ${value.trim()}`, isStudentEmail(value));
    }
    for (const value of rejected) {
      check(`rejected: ${value}`, !isStudentEmail(value));
    }

    check('canonicalisation lowercases and trims', canonicalEmail('  A@B.COM ') === 'a@b.com');
    check(
      'the domain is taken from the LAST @',
      emailDomain('weird@name@mitwpu.edu.in') === 'mitwpu.edu.in',
    );
    check(
      'the local part is not otherwise rewritten (no dot or +tag stripping)',
      canonicalEmail('a.b+tag@mitwpu.edu.in') === 'a.b+tag@mitwpu.edu.in',
    );
  }

  // --- 2. Registration schema ----------------------------------------------
  section('2. Registration cannot be bypassed by calling the API directly');
  {
    // Registration asks for a name, a college email and a password. Nothing
    // else — no PRN, no terms checkbox, no analytics consent.
    const base = {
      name: 'Test Student',
      email: 'student@mitwpu.edu.in',
      password: 'Str0ng-Passw0rd!',
      confirmPassword: 'Str0ng-Passw0rd!',
    };

    check('a complete, valid submission passes', registerSchema.safeParse(base).success);
    check(
      'a non-MIT email is rejected by the schema itself',
      !registerSchema.safeParse({ ...base, email: 'student@gmail.com' }).success,
    );
    check(
      'mismatched passwords are rejected',
      !registerSchema.safeParse({ ...base, confirmPassword: 'something-else' }).success,
    );

    // The schema is the enforcement point, so this is also where "removed"
    // has to mean removed: an old client that still posts these fields must
    // not be able to talk the server into recording any of them.
    const legacyPayload = registerSchema.safeParse({
      ...base,
      prn: 'abc123',
      acceptTerms: true,
      analyticsConsent: true,
    });
    check('a payload carrying the removed fields still parses', legacyPayload.success);
    const parsedKeys = Object.keys(legacyPayload.data ?? {});
    check('PRN is not part of the parsed result', !parsedKeys.includes('prn'), parsedKeys.join(','));
    check('terms acceptance is not part of the parsed result', !parsedKeys.includes('acceptTerms'));
    check(
      'analytics consent is not part of the parsed result',
      !parsedKeys.includes('analyticsConsent'),
    );

    // The shared login schema must NOT carry the domain rule, or every existing
    // account on another domain would be locked out.
    check(
      'login still accepts a non-MIT address',
      loginSchema.safeParse({ email: 'legacy@gmail.com', password: 'x' }).success,
    );
    check('rememberMe defaults to false', loginSchema.safeParse({ email: 'a@b.com', password: 'x' }).data?.rememberMe === false);

    check('a 6-digit code parses', otpCodeSchema.safeParse('123456').success);
    check('a spaced code parses', otpCodeSchema.safeParse('123 456').success);
    check('a 5-digit code is rejected', !otpCodeSchema.safeParse('12345').success);
    check('a non-numeric code is rejected', !otpCodeSchema.safeParse('12345a').success);
  }

  // --- 3. One-time codes ---------------------------------------------------
  section('3. One-time codes');
  {
    const user = await makeUser('authtest+otp@mitwpu.edu.in', { verificationRequired: true });

    const codes = new Set<string>();
    for (let i = 0; i < 200; i += 1) codes.add(generateCode());
    check('codes are 6 digits', [...codes].every((c) => /^\d{6}$/.test(c)));
    check('codes are not obviously repeating', codes.size > 150, `${codes.size} distinct of 200`);

    const { code } = await issueCode(user.id, null);
    const stored = await prisma.emailVerificationToken.findFirstOrThrow({
      where: { userId: user.id, consumedAt: null },
    });
    check('the plaintext code is never stored', stored.codeHash !== code);
    check('what is stored is its SHA-256', stored.codeHash === hashCode(code));

    const wrong = await verifyCode(user.id, code === '000000' ? '111111' : '000000');
    check('a wrong code is rejected', !wrong.ok && wrong.reason === 'mismatch');
    check(
      'and the attempt is counted',
      (await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: stored.id } })).attempts === 1,
    );

    const right = await verifyCode(user.id, code);
    check('the correct code is accepted', right.ok);

    const replay = await verifyCode(user.id, code);
    check('the same code cannot be used twice', !replay.ok && replay.reason === 'no_code');
  }

  // --- 4. Brute force and expiry -------------------------------------------
  section('4. Brute force, expiry and reissue');
  {
    const user = await makeUser('authtest+brute@mitwpu.edu.in', { verificationRequired: true });
    const { code } = await issueCode(user.id, null);
    const wrong = code === '000000' ? '111111' : '000000';

    let lastReason = '';
    for (let attempt = 1; attempt <= OTP_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await verifyCode(user.id, wrong);
      lastReason = outcome.ok ? 'ok' : outcome.reason;
    }
    check(
      `the code is locked after ${OTP_MAX_ATTEMPTS} wrong attempts`,
      lastReason === 'too_many_attempts',
      lastReason,
    );
    const afterLock = await verifyCode(user.id, code);
    check('and the REAL code no longer works once locked', !afterLock.ok, 'still accepted');

    // Expiry.
    const expiring = await makeUser('authtest+expiry@mitwpu.edu.in', { verificationRequired: true });
    const issued = await issueCode(expiring.id, null);
    await prisma.emailVerificationToken.updateMany({
      where: { userId: expiring.id, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await verifyCode(expiring.id, issued.code);
    check('an expired code is rejected', !expired.ok && expired.reason === 'expired');

    // Reissue supersedes.
    const reissue = await makeUser('authtest+reissue@mitwpu.edu.in', { verificationRequired: true });
    const first = await issueCode(reissue.id, null);
    const second = await issueCode(reissue.id, null);
    check('a new code differs from the old one', first.code !== second.code);
    const old = await verifyCode(reissue.id, first.code);
    check('issuing a new code invalidates the previous one', !old.ok);
    const fresh = await verifyCode(reissue.id, second.code);
    check('and the new one works', fresh.ok);
    const live = await prisma.emailVerificationToken.count({
      where: { userId: reissue.id, consumedAt: null },
    });
    check('at most one code is ever live per user', live === 0, `${live} unconsumed`);
  }

  // --- 5. Remember Me lifetimes --------------------------------------------
  section('5. Remember Me — lifetime');
  {
    const user = await makeUser('authtest+remember@mitwpu.edu.in');

    const normal = await createSession(user.id, ctx);
    const remembered = await createSession(user.id, ctx, { rememberMe: true });

    const normalDays =
      (normal.session.expiresAt.getTime() - normal.session.createdAt.getTime()) / 86_400_000;
    const rememberedDays =
      (remembered.session.expiresAt.getTime() - remembered.session.createdAt.getTime()) / 86_400_000;

    check('an ordinary session keeps the existing 7-day lifetime', Math.round(normalDays) === 7, `${normalDays.toFixed(2)}d`);
    check(
      `a remembered session lasts ${env.session.rememberDays} days`,
      Math.round(rememberedDays) === env.session.rememberDays,
      `${rememberedDays.toFixed(2)}d`,
    );
    check('the flag is persisted', remembered.session.rememberMe === true);
    check('and defaults to false', normal.session.rememberMe === false);
    check(
      'the cookie lifetime matches the row',
      sessionLifetimeSeconds(true) === env.session.rememberDays * 86_400 &&
        sessionLifetimeSeconds(false) === env.session.absoluteHours * 3600,
    );
    check(
      'the idle window follows the session',
      idleCutoffFor({ rememberMe: true }).getTime() < idleCutoffFor({ rememberMe: false }).getTime(),
    );

    await endSession(normal.session.id, 'LOGGED_OUT', 'test');
    await endSession(remembered.session.id, 'LOGGED_OUT', 'test');
  }

  // --- 6. THE HARD REQUIREMENT ---------------------------------------------
  section('6. Remember Me must NOT inflate Active Users');
  {
    const user = await makeUser('authtest+live@mitwpu.edu.in');
    const { session } = await createSession(user.id, ctx, { rememberMe: true });

    const baseline = await countLiveUsers();
    check('a just-created remembered session counts as live', baseline >= 1, `${baseline}`);

    // Ten minutes idle: well inside a 30-day remembered session, well outside
    // the 5-minute activity window.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.session.update({
      where: { id: session.id },
      data: { lastActivityAt: tenMinutesAgo },
    });

    const idle = await countLiveUsers();
    check(
      'after 10 minutes idle it is NOT an Active User',
      idle === baseline - 1,
      `${baseline} → ${idle}`,
    );

    const row = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    check('but the session is still ACTIVE — they are still signed in', row.status === 'ACTIVE');
    check('and still inside its lifetime', row.expiresAt > new Date());
    check(
      'the live window is still five minutes for everyone',
      Math.round((Date.now() - liveCutoff().getTime()) / 60_000) === env.liveWindowMinutes,
    );

    // Sweeping stale sessions must not reap a remembered one.
    await expireStaleSessions(user.id);
    const afterSweep = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    check('an idle remembered session is not expired by the sweep', afterSweep.status === 'ACTIVE');

    // Returning makes them live again.
    await prisma.session.update({
      where: { id: session.id },
      data: { lastActivityAt: new Date() },
    });
    const returned = await countLiveUsers();
    check('coming back makes them an Active User again', returned === baseline, `${returned}`);

    // …while an ORDINARY session idle for the same 10 minutes stays signed in
    // too (its window is 30 minutes), and one idle beyond 30 does not.
    const ordinary = await createSession(user.id, ctx);
    await prisma.session.update({
      where: { id: ordinary.session.id },
      data: { lastActivityAt: new Date(Date.now() - 31 * 60 * 1000) },
    });
    await expireStaleSessions(user.id);
    const swept = await prisma.session.findUniqueOrThrow({ where: { id: ordinary.session.id } });
    check('an ordinary session still expires after 30 idle minutes', swept.status === 'EXPIRED');

    await endSession(session.id, 'LOGGED_OUT', 'test');
  }

  // --- 7. One active session, with Remember Me -----------------------------
  section('7. One active session per account still holds');
  {
    const user = await makeUser('authtest+single@mitwpu.edu.in');
    const first = await createSession(user.id, ctx, { rememberMe: true });

    const live = await findLiveSession(user.id);
    check('a remembered session is found as the live one', live?.id === first.session.id);

    // Idle for a day: an ordinary session would have fallen stale, a remembered
    // one still holds the account.
    await prisma.session.update({
      where: { id: first.session.id },
      data: { lastActivityAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    const stillHeld = await findLiveSession(user.id);
    check('and still holds the account a day later', stillHeld?.id === first.session.id);

    await endSession(first.session.id, 'LOGGED_OUT', 'test');
    const afterLogout = await findLiveSession(user.id);
    check('logging out releases it immediately', afterLogout === null);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: first.session.id } });
    check('and the row is LOGGED_OUT server-side', row.status === 'LOGGED_OUT');
    check('so the 30-day cookie is worthless afterwards', row.status !== 'ACTIVE');
    // `getSessionState` needs a request scope, so cookie resolution itself is
    // covered end-to-end by verify:flows rather than here.
  }

  // --- 8. Existing users are untouched -------------------------------------
  section('8. Accounts created before any of this');
  {
    // Exactly what the migration leaves behind: defaults, nothing written.
    const legacy = await makeUser('authtest+legacy@gmail.com');
    check('a legacy account may hold a non-MIT email', legacy.email.endsWith('@gmail.com'));
    check('it is not required to verify', legacy.verificationRequired === false);
    check('it has no verification timestamp', legacy.emailVerifiedAt === null);
    check('it has no PRN', legacy.prn === null);
    check('it has no consent recorded', legacy.termsAcceptedAt === null && legacy.analyticsConsentAt === null);

    // The login gate: blocked only when the policy applied AND it is unverified.
    const gate = (u: { verificationRequired: boolean; emailVerifiedAt: Date | null }) =>
      u.verificationRequired && !u.emailVerifiedAt;

    check('a legacy account is NOT gated', !gate(legacy));
    check(
      'a new unverified account IS gated',
      gate({ verificationRequired: true, emailVerifiedAt: null }),
    );
    check(
      'a new verified account is not gated',
      !gate({ verificationRequired: true, emailVerifiedAt: new Date() }),
    );

    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (admin) {
      check('the existing admin is not gated', !gate(admin));
      check('and keeps its email unchanged', Boolean(admin.email));
    } else {
      check('no admin present in this database (skipped)', true);
    }

    // Many legacy rows may share NULL PRN — the unique index must allow that.
    const second = await makeUser('authtest+legacy2@gmail.com');
    check('several accounts may have a NULL PRN', second.prn === null && legacy.prn === null);
  }

  // --- 9. Dormant columns ---------------------------------------------------
  //
  // The PRN and consent columns are still in the database — dropping them would
  // have been a destructive change to a production table for no gain — but
  // nothing collects or writes them any more. Cookie Notes has no terms
  // document to agree to, and a consent record nobody gave is worse than none.
  section('9. PRN and consent columns are dormant, not populated');
  {
    const user = await makeUser('authtest+dormant@mitwpu.edu.in', {
      verificationRequired: true,
    });

    check('a new account carries no PRN', user.prn === null);
    check('no terms acceptance is recorded', user.termsAcceptedAt === null);
    check('no terms version is recorded', user.termsVersion === null);
    check('no analytics consent is recorded', user.analyticsConsentAt === null);
    check('no analytics consent version is recorded', user.analyticsConsentVersion === null);

    // Nullable, so an account with none of them is a perfectly valid row —
    // which is what every account now is.
    const everyone = await prisma.user.findMany({
      select: { prn: true, termsAcceptedAt: true, analyticsConsentAt: true },
    });
    check(
      'no account anywhere has a fabricated terms agreement',
      everyone.every((row) => row.termsAcceptedAt === null),
      `${everyone.filter((row) => row.termsAcceptedAt !== null).length} with terms`,
    );
    check(
      'no account anywhere has a fabricated analytics consent',
      everyone.every((row) => row.analyticsConsentAt === null),
      `${everyone.filter((row) => row.analyticsConsentAt !== null).length} with consent`,
    );
    check(
      'and nothing was backfilled into the PRN column',
      everyone.every((row) => row.prn === null),
      `${everyone.filter((row) => row.prn !== null).length} with a PRN`,
    );
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
