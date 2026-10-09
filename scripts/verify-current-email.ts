/**
 * Verifies "Verify my current email" — the path for an existing student whose
 * address is already on the college domain — that the address-change path still
 * works, and that one-time codes are bound, serialised and failure-safe.
 *
 *   npm run build
 *   DATABASE_URL=<local test db> VERIFY_DISPOSABLE_DB=<its name> npm run verify:current-email
 *
 * The suite starts its OWN production server (a `next start` on a free loopback
 * port) with exactly the database it has approved, and then proves the server is
 * using it before any test runs. It does not talk to a server you started, and
 * VERIFY_BASE_URL must not be set: a server on loopback says nothing about which
 * database it is connected to.
 *
 * Runs against a real HTTP server with real cookies and a real database. The
 * emailed code cannot be read from here, so where a test needs a known code it
 * is issued straight through `issueCode` (the same function the routes use);
 * where a route's own behaviour is what is being tested — sending, cooldown,
 * rate limits, what it does with a body — the route is called.
 *
 * Fixtures are prefixed `curtest+`, use their own fake client addresses, and are
 * removed before and after. This suite creates and deletes accounts, so it
 * REFUSES TO RUN unless the database is a disposable local one that you have
 * named in VERIFY_DISPOSABLE_DB (see scripts/lib/disposable-db.ts). It will not
 * run against Neon, Production, or any URL it cannot positively identify as a
 * loopback test database — including whatever `.env` happens to point at.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { ALLOWED_QUERY_PARAMETERS, evaluateDatabaseIdentity, evaluateTestTarget } from './lib/disposable-db';
import { confirmServerUsesDatabase, startOwnedServer, type OwnedServer } from './lib/test-server';

// First line of defence, before anything can connect: is this target approved?
const targetVerdict = evaluateTestTarget(process.env);
if (!targetVerdict.ok) {
  console.error('\nREFUSING TO RUN — this suite only runs against an approved, disposable local database:');
  for (const reason of targetVerdict.reasons) console.error(`  • ${reason}`);
  console.error('\nNothing was connected to and nothing was changed.\n');
  process.exit(3);
}

// The OTP, mail and testimonial modules are marked `server-only`, which throws
// outside a React Server Component. Neutralise the marker before importing them.
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

/** Set once the suite's own server is up and has proved it uses the approved database. */
let BASE_URL = '';
let ownedServer: OwnedServer | undefined;
const PREFIX = 'curtest';
const PASSWORD = 'Current-Email-2026!';
const COLLEGE = 'mitwpu.edu.in';
/** Documentation-range addresses, so cleanup can never touch another suite's rate-limit rows. */
const IP_PREFIX = '198.51.100.';

// Only reached once the target has been approved above.
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

let ipCounter = 10;

/** A browser-ish client with its own cookie jar and its own fake network address. */
class Client {
  private cookies = new Map<string, string>();
  readonly ip = `${IP_PREFIX}${ipCounter++}`;

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        'cookie',
        [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; '),
      );
    }
    headers.set('user-agent', 'CookieNotes-Verify/current-email');
    headers.set('x-forwarded-for', this.ip);

    const response = await fetch(`${BASE_URL}${path}`, { ...init, headers, redirect: 'manual' });

    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const cookieValue = pair.slice(eq + 1).trim();
        if (cookieValue) this.cookies.set(name, cookieValue);
        else this.cookies.delete(name);
      }
    }
    return response;
  }

  json(path: string, body: unknown, method = 'POST') {
    return this.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  post(path: string) {
    return this.request(path, { method: 'POST' });
  }
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { contains: `${PREFIX}+` } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);
  await prisma.rateLimit.deleteMany({
    where: {
      OR: [
        { key: { contains: IP_PREFIX } },
        { key: { contains: `${PREFIX}+` } },
        ...ids.map((id) => ({ key: { contains: id } })),
      ],
    },
  });
  await prisma.user.deleteMany({ where: { email: { contains: `${PREFIX}+` } } });
  await prisma.user.deleteMany({ where: { pendingEmail: { contains: `${PREFIX}+` } } });
  await prisma.subject.deleteMany({ where: { name: { startsWith: '[curtest]' } } });
  await prisma.semester.deleteMany({ where: { name: { startsWith: '[curtest]' } } });
}

/** Looks for the server's own record of a failed sign-in in the approved database. */
const handshakeProbe = {
  countMarker: (marker: string) =>
    prisma.activityEvent.count({ where: { type: 'LOGIN_FAILED', metadata: { path: ['email'], equals: marker } } }),
};

async function main() {
  console.log(`\nVerifying "Verify my current email"\n${'─'.repeat(56)}`);
  // Second line of defence: ask the connected database who it is.
  const [identity] = await prisma.$queryRaw<{ db: string; addr: string | null; foreign_users: bigint }[]>`
    SELECT current_database() AS db,
           host(inet_server_addr()) AS addr,
           (SELECT count(*) FROM users WHERE email NOT LIKE ${`${PREFIX}+%`}) AS foreign_users`;
  const identityProblems = evaluateDatabaseIdentity(
    { database: identity.db, serverAddress: identity.addr, foreignUsers: Number(identity.foreign_users) },
    targetVerdict.database!,
  );
  if (identityProblems.length > 0) {
    console.error('\nREFUSING TO RUN — the connected database failed its identity check:');
    for (const reason of identityProblems) console.error(`  • ${reason}`);
    console.error('\nNothing was changed.\n');
    process.exitCode = 3;
    return;
  }

  // The server under test is ours, started with exactly the database approved
  // above — and it has to prove it is using it before anything else happens.
  const authSecret = process.env.AUTH_SECRET ?? '';
  try {
    ownedServer = await startOwnedServer({ databaseUrl: process.env.DATABASE_URL!, authSecret });
    const usesApprovedDatabase = await confirmServerUsesDatabase(ownedServer.baseUrl, handshakeProbe);
    if (!usesApprovedDatabase) throw new Error('The test server could not be shown to be using the approved database.');
    BASE_URL = ownedServer.baseUrl;
  } catch (error) {
    console.error('\nREFUSING TO RUN — the server under test could not be started and verified:');
    console.error(`  • ${error instanceof Error ? error.message : 'unknown error'}`);
    console.error('\nNo test was run.\n');
    process.exitCode = 3;
    return;
  }

  await cleanup();

  const otp = await import('../src/lib/auth/otp');
  const { issueCode, verifyCode, invalidateCode, hashCode, OTP_PURPOSE, OTP_MAX_ATTEMPTS, OTP_TTL_MINUTES, OTP_RESEND_COOLDOWN_SECONDS } = otp;
  const { rateLimit, assertWithinLimits } = await import('../src/lib/auth/rate-limit');
  const { issueAndSendCode } = await import('../src/lib/auth/send-code');
  const libPrisma = (await import('../src/lib/prisma')).prisma as unknown as Record<string, unknown>;
  const { canVerifyCurrentEmail } = await import('../src/lib/auth/current-email');
  const { needsEmailMigration } = await import('../src/lib/auth/guards');
  const { featuredTestimonials } = await import('../src/lib/testimonials');

  const PURPOSE = OTP_PURPOSE.currentEmail;

  /** Issue a code the way the routes do: for an account, a purpose and the address it is sent to. */
  const issue = (user: { id: string; email: string }, purpose: string = PURPOSE, address: string = user.email) =>
    issueCode({ userId: user.id, purpose, address, ipAddress: null });
  const verify = (user: { id: string; email: string }, code: string, purpose: string = PURPOSE, address: string = user.email) =>
    verifyCode({ userId: user.id, code, purpose, address });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const make = (name: string, extra: Record<string, unknown> = {}, domain = COLLEGE) =>
    prisma.user.create({
      data: {
        email: `${PREFIX}+${name}@${domain}`,
        name: `Cur ${name}`,
        passwordHash,
        status: 'ACTIVE',
        ...extra,
      },
    });

  /** A signed-in client for an existing account. */
  async function signIn(user: { email: string }) {
    const client = new Client();
    const response = await client.json('/api/auth/login', { email: user.email, password: PASSWORD });
    if (response.status !== 200) throw new Error(`could not sign ${user.email} in: ${response.status}`);
    return client;
  }

  const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');
  const liveTokens = (userId: string, purpose: string = PURPOSE) =>
    prisma.emailVerificationToken.findMany({
      where: { userId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  const fresh = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
  /** Runs `fn` and returns whatever it threw, or null. */
  const caught = async (fn: () => Promise<unknown>): Promise<{ status?: number; code?: string; message?: string } | null> => {
    try {
      await fn();
      return null;
    } catch (error) {
      return error as { status?: number; code?: string; message?: string };
    }
  };

  // A subject with a grant, so "entitlements survive" has something to check.
  const semester = await prisma.semester.create({
    data: { name: '[curtest] Sem', slug: `curtest-${Date.now()}`, position: 97 },
  });
  const subject = await prisma.subject.create({
    data: { semesterId: semester.id, name: '[curtest] Subject', slug: `curtest-sub-${Date.now()}` },
  });
  const grant = (userId: string) =>
    prisma.entitlement.create({
      data: {
        userId,
        scope: 'SUBJECT',
        targetKey: `SUBJECT:${subject.id}`,
        subjectId: subject.id,
        source: 'ADMIN_GRANT',
      },
    });

  // --- 1. Who is offered the path -----------------------------------------
  section('1. Who is offered "Verify my current email"');
  {
    const at = (email: string, role: 'STUDENT' | 'ADMIN' = 'STUDENT', verified = false) => ({
      role,
      email,
      emailVerifiedAt: verified ? new Date() : null,
    });
    check('an unverified student already on the college domain', canVerifyCurrentEmail(at(`a@${COLLEGE}`)));
    check('not an already-verified student', !canVerifyCurrentEmail(at(`a@${COLLEGE}`, 'STUDENT', true)));
    check('not a student on another domain', !canVerifyCurrentEmail(at('a@gmail.com')));
    check('not an admin, even on the college domain', !canVerifyCurrentEmail(at(`a@${COLLEGE}`, 'ADMIN')));
    check('not a sub-domain', !canVerifyCurrentEmail(at(`a@sub.${COLLEGE}`)));
    check('not a look-alike that merely contains the domain', !canVerifyCurrentEmail(at(`a@${COLLEGE}.evil.test`)));
    check('not a look-alike prefix', !canVerifyCurrentEmail(at(`a@fake-${COLLEGE}`)));
    check('the migration gate still applies to the same students', needsEmailMigration(at(`a@${COLLEGE}`)));
  }

  // --- 2. Access control and eligibility ----------------------------------
  section('2. Access control and eligibility');
  {
    const anon = new Client();
    const anonPost = await anon.post('/api/auth/verify-current-email');
    const anonPut = await anon.json('/api/auth/verify-current-email', { code: '123456' }, 'PUT');
    check('anonymous POST is refused (401)', anonPost.status === 401, `status ${anonPost.status}`);
    check('anonymous PUT is refused (401)', anonPut.status === 401, `status ${anonPut.status}`);
    const anonBody = await body<{ error?: string }>(anonPost);
    const anonBody2 = await body<{ error?: string }>(
      await new Client().json('/api/auth/verify-current-email', { email: `nobody@${COLLEGE}` }, 'POST'),
    );
    check('the refusal is identical whatever is sent — nothing about any account leaks', anonBody.error === anonBody2.error);

    const gmail = await make('gmail', {}, 'gmail.com');
    const gmailClient = await signIn(gmail);
    const gmailPost = await gmailClient.post('/api/auth/verify-current-email');
    check('a non-college student is not offered it (422)', gmailPost.status === 422, `status ${gmailPost.status}`);
    const gmailPut = await gmailClient.json('/api/auth/verify-current-email', { code: '123456' }, 'PUT');
    check('and cannot confirm through it (422)', gmailPut.status === 422, `status ${gmailPut.status}`);
    check('and no code was issued for them', (await liveTokens(gmail.id)).length === 0);

    const admin = await make('admin', { role: 'ADMIN' });
    const adminClient = await signIn(admin);
    check('an admin on a college address is NOT gated', !needsEmailMigration(admin));
    const adminPage = await adminClient.request('/admin');
    check('and still reaches /admin', adminPage.status === 200, `status ${adminPage.status}`);
    const adminPost = await adminClient.post('/api/auth/verify-current-email');
    check('an admin is not offered it either (422)', adminPost.status === 422, `status ${adminPost.status}`);
    check('and the admin was not marked verified by trying', (await fresh(admin.id)).emailVerifiedAt === null);
  }

  // --- 3. The path itself --------------------------------------------------
  section('3. An existing college student verifies the address they have');
  {
    const student = await make('college');
    await grant(student.id);
    const client = await signIn(student);

    const sessionBefore = await prisma.session.findFirstOrThrow({
      where: { userId: student.id, status: 'ACTIVE' },
      select: { id: true },
    });
    const before = await fresh(student.id);

    const gated = await client.json('/api/feedback', { message: 'a test message long enough', publicConsent: false });
    const gatedBody = await body<{ code?: string }>(gated);
    check('before verifying, they are gated', gated.status === 403 && gatedBody.code === 'email_migration_required', `status ${gated.status}`);

    const send = await client.post('/api/auth/verify-current-email');
    check('asking for a code succeeds', send.status === 200, `status ${send.status}`);
    const sendBody = await body<{ cooldownSeconds?: number; expiresInMinutes?: number }>(send);
    check('and states the cooldown and expiry', sendBody.cooldownSeconds === 60 && sendBody.expiresInMinutes === OTP_TTL_MINUTES);
    const [issued] = await liveTokens(student.id);
    check('exactly one live code exists, for the current-email purpose', Boolean(issued) && (await liveTokens(student.id)).length === 1);
    check('only its SHA-256 hash is stored', /^[0-9a-f]{64}$/.test(issued.codeHash));
    const minutes = (issued.expiresAt.getTime() - Date.now()) / 60000;
    check('it expires after the standard ten minutes', minutes > 9 && minutes <= OTP_TTL_MINUTES);
    check('and has used no attempts', issued.attempts === 0);
    check('asking for a code changed nothing about the account', (await fresh(student.id)).email === before.email && (await fresh(student.id)).emailVerifiedAt === null);

    // Replace the emailed code with a known one (this also proves supersede-on-reissue).
    const { code } = await issue(student);
    check('issuing a new code retires the earlier one', (await liveTokens(student.id)).length === 1);

    const wrong = await client.json('/api/auth/verify-current-email', { code: wrongFor(code) }, 'PUT');
    check('a wrong code is rejected (422)', wrong.status === 422, `status ${wrong.status}`);
    const afterWrong = await fresh(student.id);
    check('and the account is not verified', afterWrong.emailVerifiedAt === null);
    check('and the email is unchanged', afterWrong.email === before.email);
    check('and the wrong guess cost an attempt', (await liveTokens(student.id))[0]?.attempts === 1);

    const right = await client.json('/api/auth/verify-current-email', { code }, 'PUT');
    const rightBody = await body<{ verified?: boolean }>(right);
    check('the correct code verifies (200)', right.status === 200 && rightBody.verified === true, `status ${right.status}`);

    const after = await fresh(student.id);
    check('emailVerifiedAt is now set', after.emailVerifiedAt instanceof Date);
    check('the email address did not change', after.email === before.email);
    check('the user id did not change', after.id === before.id);
    check('the password hash did not change', after.passwordHash === before.passwordHash);
    check('role and status did not change', after.role === before.role && after.status === before.status);
    check('no pending address was invented', after.pendingEmail === null);
    check('the entitlement survived', (await prisma.entitlement.count({ where: { userId: student.id } })) === 1);
    const sessionAfter = await prisma.session.findFirstOrThrow({
      where: { userId: student.id, status: 'ACTIVE' },
      select: { id: true },
    });
    check('the same session is still the active one', sessionAfter.id === sessionBefore.id);
    check('and it still works', (await client.request('/account')).status === 200);
    check('the gate is lifted for the account', !needsEmailMigration(after));
    check('the code was spent', (await liveTokens(student.id)).length === 0);
    const events = await prisma.activityEvent.findMany({
      where: { userId: student.id, type: 'EMAIL_VERIFIED' },
      select: { metadata: true },
    });
    check(
      'one EMAIL_VERIFIED event was recorded, naming this flow',
      events.length === 1 && (events[0].metadata as { flow?: string } | null)?.flow === 'current_email_verification',
    );
    const again = await client.json('/api/auth/verify-current-email', { code }, 'PUT');
    const againBody = await body<{ alreadyVerified?: boolean }>(again);
    check('repeating the request is idempotent, not a second verification', again.status === 200 && againBody.alreadyVerified === true);
    check('and records no second event', (await prisma.activityEvent.count({ where: { userId: student.id, type: 'EMAIL_VERIFIED' } })) === 1);
  }

  // --- 4. Expiry, reuse and the attempt limit -------------------------------
  section('4. Expiry, reuse and attempt limits');
  {
    const expired = await make('expired');
    const expiredClient = await signIn(expired);
    const { code } = await issue(expired);
    await prisma.emailVerificationToken.updateMany({
      where: { userId: expired.id, purpose: PURPOSE },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await expiredClient.json('/api/auth/verify-current-email', { code }, 'PUT');
    check('an expired code is rejected (422)', response.status === 422, `status ${response.status}`);
    check('and does not verify the account', (await fresh(expired.id)).emailVerifiedAt === null);
    check('and is burned', (await liveTokens(expired.id)).length === 0);
    const failure = await prisma.activityEvent.findFirst({
      where: { userId: expired.id, type: 'EMAIL_VERIFICATION_FAILED' },
      select: { metadata: true },
    });
    check('the failure is recorded with its reason, never the code', (failure?.metadata as { reason?: string })?.reason === 'expired' && !JSON.stringify(failure?.metadata).includes(code));

    const reuse = await make('reuse');
    const reuseClient = await signIn(reuse);
    const spent = await issue(reuse);
    const first = await reuseClient.json('/api/auth/verify-current-email', { code: spent.code }, 'PUT');
    check('(setup) the first use succeeds', first.status === 200);
    // Put the account back to unverified so a replay reaches the code check rather than the idempotent shortcut.
    await prisma.user.update({ where: { id: reuse.id }, data: { emailVerifiedAt: null } });
    const replay = await reuseClient.json('/api/auth/verify-current-email', { code: spent.code }, 'PUT');
    check('a used code cannot be used again (422)', replay.status === 422, `status ${replay.status}`);
    check('and the replay did not verify the account', (await fresh(reuse.id)).emailVerifiedAt === null);

    const locked = await make('locked');
    const lockedClient = await signIn(locked);
    const lockedCode = await issue(locked);
    let lastMessage = '';
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
      const r = await lockedClient.json('/api/auth/verify-current-email', { code: wrongFor(lockedCode.code) }, 'PUT');
      lastMessage = (await body<{ error?: string }>(r)).error ?? '';
      if (r.status !== 422) check(`wrong guess ${i + 1} is a 422`, false, `status ${r.status}`);
    }
    check(`${OTP_MAX_ATTEMPTS} wrong guesses lock the code and say so`, /locked/i.test(lastMessage), lastMessage);
    const afterLock = await lockedClient.json('/api/auth/verify-current-email', { code: lockedCode.code }, 'PUT');
    check('after the lock, even the real code is refused', afterLock.status === 422, `status ${afterLock.status}`);
    check('and the account stayed unverified', (await fresh(locked.id)).emailVerifiedAt === null);
    const relock = await issue(locked);
    const recovered = await lockedClient.json('/api/auth/verify-current-email', { code: relock.code }, 'PUT');
    check('a freshly issued code works after a lock', recovered.status === 200, `status ${recovered.status}`);

    // Cooldown and rate limit.
    const cooldown = await make('cooldown');
    const cooldownClient = await signIn(cooldown);
    await cooldownClient.post('/api/auth/verify-current-email');
    const [t1] = await liveTokens(cooldown.id);
    const second = await cooldownClient.post('/api/auth/verify-current-email');
    const secondBody = await body<{ cooldownSeconds?: number }>(second);
    const stillOne = await liveTokens(cooldown.id);
    check('a second request inside the cooldown answers but issues nothing new', second.status === 200 && secondBody.cooldownSeconds === 60 && stillOne.length === 1 && stillOne[0].id === t1.id);
    await prisma.emailVerificationToken.update({ where: { id: t1.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
    await cooldownClient.post('/api/auth/verify-current-email');
    const [t2] = await liveTokens(cooldown.id);
    check('after the cooldown a new code is issued', t2.id !== t1.id);
    check('and the old one stops working (one live code at most)', (await liveTokens(cooldown.id)).length === 1);

    const limited = await make('limited');
    const limitedClient = await signIn(limited);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await limitedClient.post('/api/auth/verify-current-email')).status);
    check('asking for codes is rate limited (5 per hour, then 429)', statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429, statuses.join(','));
  }

  // --- 5. Isolation --------------------------------------------------------
  section('5. A code only ever verifies its own account and its own purpose');
  {
    const owner = await make('owner');
    const intruder = await make('intruder');
    const intruderClient = await signIn(intruder);
    const ownerCode = await issue(owner);
    const cross = await intruderClient.json('/api/auth/verify-current-email', { code: ownerCode.code }, 'PUT');
    check("another student's code is refused (422)", cross.status === 422, `status ${cross.status}`);
    check('the intruder was not verified', (await fresh(intruder.id)).emailVerifiedAt === null);
    check("and the owner's code is untouched, unused", (await liveTokens(owner.id))[0]?.attempts === 0);

    const sender = await make('sender');
    const senderClient = await signIn(sender);
    const victim = await make('victim');
    const smuggled = await senderClient.json('/api/auth/verify-current-email', { email: victim.email, userId: victim.id });
    check('a body naming another account or address is simply ignored', smuggled.status === 200);
    check('a code was issued for the caller only', (await liveTokens(sender.id)).length === 1);
    check('and none for the account named in the body', (await liveTokens(victim.id)).length === 0);

    const mixed = await make('mixed');
    const mixedClient = await signIn(mixed);
    const migrationCode = await issue(mixed, 'email_change', `${PREFIX}+elsewhere@${COLLEGE}`);
    const wrongPurpose = await mixedClient.json('/api/auth/verify-current-email', { code: migrationCode.code }, 'PUT');
    check('an address-change code cannot verify the current address', wrongPurpose.status === 422, `status ${wrongPurpose.status}`);
    check('and was not consumed by the attempt', (await liveTokens(mixed.id, 'email_change'))[0]?.attempts === 0);
    check('the account stayed unverified', (await fresh(mixed.id)).emailVerifiedAt === null);

    const currentCode = await issue(mixed);
    await prisma.user.update({ where: { id: mixed.id }, data: { pendingEmail: `${PREFIX}+elsewhere@${COLLEGE}` } });
    const reverse = await mixedClient.json('/api/auth/college-email', { code: currentCode.code }, 'PUT');
    const mixedAfter = await fresh(mixed.id);
    check('and a current-email code cannot move the address either', reverse.status === 422 && mixedAfter.email === mixed.email && mixedAfter.emailVerifiedAt === null, `status ${reverse.status}`);

    const sameAddress = await mixedClient.json('/api/auth/college-email', { email: mixed.email });
    check('the migration endpoint still refuses an address equal to the current one', sameAddress.status === 422, `status ${sameAddress.status}`);
  }

  // --- 6. Concurrency ------------------------------------------------------
  section('6. Simultaneous attempts cannot spend a code twice');
  {
    const racer = await make('racer');
    const racerClient = await signIn(racer);
    const { code } = await issue(racer);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => racerClient.json('/api/auth/verify-current-email', { code }, 'PUT')),
    );
    const bodies = await Promise.all(results.map((r) => body<{ verified?: boolean; alreadyVerified?: boolean }>(r)));
    const winners = bodies.filter((b, i) => results[i].status === 200 && b.verified && !b.alreadyVerified).length;
    check('ten simultaneous correct submissions: exactly one wins', winners === 1, `winners ${winners}`);
    check(
      'every other one is refused or reported as already done',
      results.every(
        (r, i) =>
          r.status === 422 ||
          (r.status === 200 && (bodies[i].alreadyVerified === true || (bodies[i].verified && !bodies[i].alreadyVerified))),
      ) && results.filter((r, i) => r.status === 200 && !bodies[i].alreadyVerified).length === 1,
      results.map((r) => r.status).join(','),
    );
    check('the account is verified once', (await fresh(racer.id)).emailVerifiedAt instanceof Date);
    check('exactly one EMAIL_VERIFIED event was written', (await prisma.activityEvent.count({ where: { userId: racer.id, type: 'EMAIL_VERIFIED' } })) === 1);
    check('and the code is spent', (await liveTokens(racer.id)).length === 0);

    const twin = await make('twin');
    const twinCode = await issue(twin);
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => verify(twin, twinCode.code)));
    check('twelve simultaneous verifyCode calls: exactly one returns ok', outcomes.filter((o) => o.ok).length === 1, JSON.stringify(outcomes.map((o) => (o.ok ? 'ok' : o.reason))));

    const flood = await make('flood');
    const floodCode = await issue(flood);
    await Promise.all(Array.from({ length: 40 }, () => verify(flood, wrongFor(floodCode.code))));
    const floodToken = await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: flood.id, purpose: PURPOSE } });
    check('forty simultaneous wrong guesses are held to the allowance', floodToken.attempts === OTP_MAX_ATTEMPTS, `attempts ${floodToken.attempts}`);
    check('and burn the code', floodToken.consumedAt !== null);
    check('so the real code no longer works', !(await verify(flood, floodCode.code)).ok);
  }

  // --- 7. The migration path is unchanged ----------------------------------
  section('7. A non-college student still migrates to a college address');
  {
    const legacy = await make('migrator', {}, 'gmail.com');
    await grant(legacy.id);
    const client = await signIn(legacy);
    const before = await fresh(legacy.id);
    const sessionBefore = await prisma.session.findFirstOrThrow({ where: { userId: legacy.id, status: 'ACTIVE' }, select: { id: true } });
    const target = `${PREFIX}+moved@${COLLEGE}`;

    const rejected = await client.json('/api/auth/college-email', { email: 'someone@gmail.com' });
    check('a non-college target is refused (422)', rejected.status === 422, `status ${rejected.status}`);
    const propose = await client.json('/api/auth/college-email', { email: target });
    check('a college target is accepted (200)', propose.status === 200, `status ${propose.status}`);
    const proposed = await fresh(legacy.id);
    check('it is only proposed: email unchanged, still unverified', proposed.email === before.email && proposed.pendingEmail === target && proposed.emailVerifiedAt === null);

    const { code } = await issue(legacy, 'email_change', target);
    const wrong = await client.json('/api/auth/college-email', { code: wrongFor(code) }, 'PUT');
    check('a wrong code is refused', wrong.status === 422, `status ${wrong.status}`);
    const afterWrong = await fresh(legacy.id);
    check('and neither moves the email nor verifies the account', afterWrong.email === before.email && afterWrong.emailVerifiedAt === null && afterWrong.pendingEmail === target);

    const right = await client.json('/api/auth/college-email', { code }, 'PUT');
    check('the right code completes the move (200)', right.status === 200, `status ${right.status}`);
    const after = await fresh(legacy.id);
    check('the account now has the college address', after.email === target);
    check('and is verified', after.emailVerifiedAt instanceof Date);
    check('the proposal is cleared', after.pendingEmail === null);
    check('the user id and password hash are unchanged', after.id === before.id && after.passwordHash === before.passwordHash);
    check('the entitlement survived', (await prisma.entitlement.count({ where: { userId: legacy.id } })) === 1);
    const sessionAfter = await prisma.session.findFirstOrThrow({ where: { userId: legacy.id, status: 'ACTIVE' }, select: { id: true } });
    check('the session survived', sessionAfter.id === sessionBefore.id && (await client.request('/account')).status === 200);
    const moved = await prisma.activityEvent.findFirst({ where: { userId: legacy.id, type: 'EMAIL_VERIFIED' }, select: { metadata: true } });
    check('and its event still names the migration flow', (moved?.metadata as { flow?: string } | null)?.flow === 'college_email_migration');
  }

  // --- 7b. A college-address student who mistyped it ------------------------
  section('7b. A student on a college address can move to the correct one');
  {
    const typo = await make('typo');
    await grant(typo.id);
    const client = await signIn(typo);
    const before = await fresh(typo.id);
    const sessionBefore = await prisma.session.findFirstOrThrow({ where: { userId: typo.id, status: 'ACTIVE' }, select: { id: true } });
    const target = `${PREFIX}+typo-fixed@${COLLEGE}`;

    const own = await client.json('/api/auth/college-email', { email: typo.email });
    const ownBody = await body<{ error?: string }>(own);
    check('proposing the address they already have is refused (422)', own.status === 422, `status ${own.status}`);
    check('and the message points them to "Verify my current email"', /Verify my current email/.test(ownBody.error ?? ''), ownBody.error);
    const other = await client.json('/api/auth/college-email', { email: 'someone@gmail.com' });
    check('a non-college address is still refused (422)', other.status === 422, `status ${other.status}`);

    const holder = await make('holder');
    const taken = await client.json('/api/auth/college-email', { email: holder.email });
    const takenBody = await body<{ error?: string }>(taken);
    const afterTaken = await fresh(typo.id);
    check('an address another account owns is refused (422)', taken.status === 422, `status ${taken.status}`);
    check('without saying whose it is', /cannot be used/i.test(takenBody.error ?? '') && !takenBody.error?.includes(holder.name));
    check('and nothing was proposed or changed', afterTaken.pendingEmail === null && afterTaken.email === before.email && afterTaken.emailVerifiedAt === null);

    const propose = await client.json('/api/auth/college-email', { email: target });
    check('a different college address is accepted (200)', propose.status === 200, `status ${propose.status}`);
    const proposed = await fresh(typo.id);
    check('it is only proposed: email unchanged, still unverified', proposed.email === before.email && proposed.pendingEmail === target && proposed.emailVerifiedAt === null);
    check('the code is an address-change code, held for the NEW address flow', (await liveTokens(typo.id, 'email_change')).length === 1 && (await liveTokens(typo.id)).length === 0);

    const { code } = await issue(typo, 'email_change', target);
    const wrong = await client.json('/api/auth/college-email', { code: wrongFor(code) }, 'PUT');
    const afterWrong = await fresh(typo.id);
    check('a wrong code is refused and changes nothing', wrong.status === 422 && afterWrong.email === before.email && afterWrong.emailVerifiedAt === null && afterWrong.pendingEmail === target);

    const right = await client.json('/api/auth/college-email', { code }, 'PUT');
    check('the right code completes the move (200)', right.status === 200, `status ${right.status}`);
    const after = await fresh(typo.id);
    check('the account now has the corrected address', after.email === target);
    check('and is verified', after.emailVerifiedAt instanceof Date);
    check('the proposal is cleared', after.pendingEmail === null);
    check('the user id and password hash are unchanged', after.id === before.id && after.passwordHash === before.passwordHash);
    check('the entitlement survived', (await prisma.entitlement.count({ where: { userId: typo.id } })) === 1);
    const sessionAfter = await prisma.session.findFirstOrThrow({ where: { userId: typo.id, status: 'ACTIVE' }, select: { id: true } });
    check('the session survived and still works', sessionAfter.id === sessionBefore.id && (await client.request('/account')).status === 200);
    const moved = await prisma.activityEvent.findFirst({ where: { userId: typo.id, type: 'EMAIL_VERIFIED' }, select: { metadata: true } });
    check('the event names the address-change flow', (moved?.metadata as { flow?: string } | null)?.flow === 'college_email_migration');
    const oldLogin = await new Client().json('/api/auth/login', { email: typo.email, password: PASSWORD });
    check('the mistyped address no longer signs in', oldLogin.status !== 200, `status ${oldLogin.status}`);
    const newLogin = await new Client().json('/api/auth/login', { email: target, password: PASSWORD, force: true });
    check('the corrected address does', newLogin.status === 200, `status ${newLogin.status}`);
  }

  // --- 8. Which screen each student gets -----------------------------------
  section('8. The verification screen offers the right flow');
  {
    const college = await make('screen-college');
    const collegeClient = await signIn(college);
    const html = await (await collegeClient.request('/verify-college-email')).text();
    check('a college student sees "Verify my current email"', html.includes('Verify my current email'));
    check('with their own address shown', html.includes(college.email));
    check('and no address field to fill in', !html.includes('id="collegeEmail"') && !html.includes('you@mitwpu.edu.in'));
    check('with a way out for a mistyped address', html.includes('Use a different MIT-WPU email'));

    await collegeClient.post('/api/auth/verify-current-email');
    const resumed = await (await collegeClient.request('/verify-college-email')).text();
    check('after a code was sent, a revisit resumes at the code step', resumed.includes('Enter the 6-digit code sent to'));

    const pendingStudent = await make('screen-pending', { pendingEmail: `${PREFIX}+screen-pending-new@${COLLEGE}` });
    const pendingClient = await signIn(pendingStudent);
    const pendingHtml = await (await pendingClient.request('/verify-college-email')).text();
    check('a student who already proposed a different address resumes that flow at the code step', pendingHtml.includes('Enter the 6-digit code sent to') && pendingHtml.includes(`${PREFIX}+screen-pending-new@${COLLEGE}`));
    check('and is not shown the current-email button', !pendingHtml.includes('Verify my current email'));

    const other = await make('screen-other', {}, 'gmail.com');
    const otherClient = await signIn(other);
    const otherHtml = await (await otherClient.request('/verify-college-email')).text();
    check('a non-college student sees the address form', otherHtml.includes('Update your college email') && otherHtml.includes('Send verification code'));
    check('and not the current-email button', !otherHtml.includes('Verify my current email'));
  }

  // --- 9. Nothing leaks about which accounts exist -------------------------
  section('9. Unknown accounts are indistinguishable from known ones');
  {
    const known = await make('known', { verificationRequired: true });
    const probe = new Client();
    const unknownResponse = await probe.json('/api/auth/verify-email', { email: `nobody-${Date.now()}@${COLLEGE}`, code: '123456' });
    const knownResponse = await new Client().json('/api/auth/verify-email', { email: known.email, code: '123456' });
    const a = await body<{ error?: string; code?: string }>(unknownResponse);
    const b = await body<{ error?: string; code?: string }>(knownResponse);
    check('verifying a code: unknown and known addresses get the same status', unknownResponse.status === knownResponse.status, `${unknownResponse.status} vs ${knownResponse.status}`);
    check('and the same message', a.error === b.error && a.code === b.code);
    const unknownResend = await new Client().json('/api/auth/verify-email', { email: `nobody-${Date.now()}@${COLLEGE}` }, 'PUT');
    const knownResend = await new Client().json('/api/auth/verify-email', { email: known.email }, 'PUT');
    check('asking for a resend: unknown and known addresses answer alike', unknownResend.status === knownResend.status && JSON.stringify(await body(unknownResend)) === JSON.stringify(await body(knownResend)));
  }

  // --- 10. Public testimonials ---------------------------------------------
  section('10. Only reviewed, consented, featured feedback is public');
  {
    const author = await make('author');
    const row = (tag: string, data: Record<string, unknown>) =>
      prisma.feedback.create({
        data: {
          userId: author.id,
          message: `CURVIS-${tag}`,
          publicConsent: true,
          status: 'REVIEWED',
          featured: true,
          featuredAt: new Date(),
          ...data,
        },
      });
    await row('all-three', {});
    await row('no-consent', { publicConsent: false });
    await row('not-featured', { featured: false, featuredAt: null });
    await row('pending', { status: 'PENDING' });
    await row('archived', { status: 'ARCHIVED' });
    const shown = (await featuredTestimonials(100)).map((t) => t.message).filter((m) => m.startsWith('CURVIS-'));
    check('a reviewed, consented, featured testimonial is returned', shown.includes('CURVIS-all-three'));
    check('without consent: not returned', !shown.includes('CURVIS-no-consent'));
    check('not featured: not returned', !shown.includes('CURVIS-not-featured'));
    check('still pending: not returned', !shown.includes('CURVIS-pending'));
    check('archived: not returned', !shown.includes('CURVIS-archived'));
    check('exactly one of the five is public', shown.length === 1, shown.join(', '));
  }

  // --- 11. A code is bound to the address it was sent to ----------------------
  section('11. A code is only good for the address it was sent to');
  {
    const B = `${PREFIX}+bound-b@${COLLEGE}`;
    const C = `${PREFIX}+bound-c@${COLLEGE}`;
    const bound = await make('bound');

    const forB = await issue(bound, 'email_change', B);
    const wrongAddress = await verify(bound, forB.code, 'email_change', C);
    check('a code issued for B does not verify against C', !wrongAddress.ok && wrongAddress.reason === 'mismatch');
    const row = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: forB.tokenId } });
    check('and the wrong-address attempt cost an attempt, like any wrong guess', row.attempts === 1 && row.consumedAt === null);
    const rightAddress = await verify(bound, forB.code, 'email_change', ` ${B.toUpperCase()} `);
    check('against B it works, however B is capitalised or padded', rightAddress.ok);

    const probe = await issue(bound, 'email_change', B);
    const stored = (await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: probe.tokenId } })).codeHash;
    const { createHash } = await import('node:crypto');
    const by = (userId: string, purpose: string, address: string) => hashCode(probe.code, { userId, purpose, address });
    check('what is stored is a 64-character keyed hash', /^[0-9a-f]{64}$/.test(stored));
    check('it is bound to the address', stored === by(bound.id, 'email_change', B) && stored !== by(bound.id, 'email_change', C));
    check('to the account', stored !== by('some-other-account', 'email_change', B));
    check('and to the purpose', stored !== by(bound.id, PURPOSE, B));
    check('and it is not the bare SHA-256 of the code', stored !== createHash('sha256').update(probe.code).digest('hex'));

    // The race the review found: the address on file is C, but the only live code
    // was sent to B. B's owner must not be able to move the account to C.
    const raced = await make('raced', {}, 'gmail.com');
    const racedClient = await signIn(raced);
    await racedClient.json('/api/auth/college-email', { email: B });
    await prisma.user.update({ where: { id: raced.id }, data: { pendingEmail: C } });
    const codeSentToB = await issue(raced, 'email_change', B);
    const promote = await racedClient.json('/api/auth/college-email', { code: codeSentToB.code }, 'PUT');
    const after = await fresh(raced.id);
    check("B's code cannot move the account to C (422)", promote.status === 422, `status ${promote.status}`);
    check('the email did not move and the account is not verified', after.email === raced.email && after.emailVerifiedAt === null);
    check('and C was not adopted', after.pendingEmail === C);
    const codeSentToC = await issue(raced, 'email_change', C);
    const proper = await racedClient.json('/api/auth/college-email', { code: codeSentToC.code }, 'PUT');
    check('a code sent to C, with C on file, does complete the move', proper.status === 200 && (await fresh(raced.id)).email === C, `status ${proper.status}`);
  }

  // --- 12. Concurrent sends --------------------------------------------------
  section('12. Concurrent sends are serialised');
  {
    const burst = await make('burst');
    const results = await Promise.all(Array.from({ length: 15 }, () => issue(burst)));
    const all = await prisma.emailVerificationToken.findMany({ where: { userId: burst.id, purpose: PURPOSE } });
    check('fifteen simultaneous issues leave exactly one live code', all.filter((t) => t.consumedAt === null).length === 1, `${all.filter((t) => t.consumedAt === null).length} live`);
    check('and every other one was superseded, not left usable', all.length === 15 && all.filter((t) => t.consumedAt !== null).length === 14);
    // Only the newest code is in force. Try it first (wrong guesses would burn it),
    // then every other code: none of them may work.
    const live = (await liveTokens(burst.id))[0];
    const inForce = results.find((r) => r.tokenId === live.id)!;
    check('the code that is in force is the one that works', (await verify(burst, inForce.code)).ok);
    const others = await Promise.all(results.filter((r) => r.tokenId !== live.id).map((r) => verify(burst, r.code)));
    check('none of the other fourteen can be spent', others.every((o) => !o.ok));

    const gated = await make('gated');
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => issueCode({ userId: gated.id, purpose: PURPOSE, address: gated.email, ipAddress: null, cooldownSeconds: 60 })),
    );
    check('ten simultaneous sends with a cooldown: exactly one is issued', attempts.filter((a) => a.status === 'issued').length === 1, attempts.map((a) => a.status).join(','));
    check('and the rest are told to wait, with a code in force', attempts.filter((a) => a.status === 'cooldown').every((a) => a.status === 'cooldown' && a.live && a.retryAfterSeconds >= 1));
    check('only one code row was created', (await prisma.emailVerificationToken.count({ where: { userId: gated.id, purpose: PURPOSE } })) === 1);

    // The address-change flow: proposal and code are one unit, however requests interleave.
    const mover = await make('mover', {}, 'gmail.com');
    const targets = [`${PREFIX}+mv-b@${COLLEGE}`, `${PREFIX}+mv-c@${COLLEGE}`];
    const proposals = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        issueCode({
          userId: mover.id,
          purpose: 'email_change',
          address: targets[i % 2],
          ipAddress: null,
          cooldownSeconds: 60,
          inTransaction: async (tx) => {
            await tx.user.update({ where: { id: mover.id }, data: { pendingEmail: targets[i % 2] } });
          },
        }).then((r) => ({ r, address: targets[i % 2] })),
      ),
    );
    const winners = proposals.filter((p) => p.r.status === 'issued');
    check('eight simultaneous proposals (two addresses): exactly one is issued', winners.length === 1);
    const winner = winners[0];
    const moverNow = await fresh(mover.id);
    const moverToken = await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: mover.id, purpose: 'email_change', consumedAt: null } });
    check('the proposal on file is the winner\'s address', moverNow.pendingEmail === winner.address);
    check('and the live code is bound to that same address', winner.r.status === 'issued' && moverToken.codeHash === hashCode(winner.r.code, { userId: mover.id, purpose: 'email_change', address: winner.address }));
    check('the losers changed nothing (no stray proposal, no second code)', (await prisma.emailVerificationToken.count({ where: { userId: mover.id, purpose: 'email_change' } })) === 1);

    // Over HTTP.
    const http = await make('http-burst');
    const httpClient = await signIn(http);
    const posts = await Promise.all(Array.from({ length: 10 }, () => httpClient.post('/api/auth/verify-current-email')));
    const codes = posts.map((r) => r.status).sort();
    check('ten simultaneous sends over HTTP: exactly five are allowed (the hourly limit), the rest are 429', codes.filter((c) => c === 200).length === 5 && codes.filter((c) => c === 429).length === 5, codes.join(','));
    check('and exactly one code exists afterwards', (await prisma.emailVerificationToken.count({ where: { userId: http.id, purpose: PURPOSE } })) === 1);
  }

  // --- 13. The rate limiter ---------------------------------------------------
  section('13. The rate limiter is atomic and fails closed');
  {
    const key = `${PREFIX}+limit-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 40 }, () => rateLimit(key, 5, 60)));
    check('forty simultaneous first requests: exactly five are allowed', results.filter((r) => r.allowed).length === 5, `${results.filter((r) => r.allowed).length} allowed`);
    const counted = await prisma.rateLimit.findUniqueOrThrow({ where: { key } });
    check('and every attempt was counted — the counter is not reset by the race', counted.count === 40, `count ${counted.count}`);
    const denied = await rateLimit(key, 5, 60);
    check('a refused attempt reports how long to wait', !denied.allowed && denied.retryAfterSeconds > 3000);
    const stillSame = await prisma.rateLimit.findUniqueOrThrow({ where: { key } });
    check('and does not extend the window', stillSame.expiresAt.getTime() === counted.expiresAt.getTime());

    await prisma.rateLimit.update({ where: { key }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const reopened = await rateLimit(key, 5, 60);
    check('after the window ends the count starts again', reopened.allowed && reopened.remaining === 4);
    check('with a fresh window', (await prisma.rateLimit.findUniqueOrThrow({ where: { key } })).count === 1);

    // Failure behaviour.
    const original = libPrisma.$queryRaw;
    const broken = async () => { throw new Error('simulated database failure'); };
    libPrisma.$queryRaw = broken;
    let closed, open, thrown: unknown;
    try {
      closed = await rateLimit(`${key}-closed`, 5, 60, { failClosed: true });
      open = await rateLimit(`${key}-open`, 5, 60);
      try { assertWithinLimits(closed); } catch (error) { thrown = error; }
    } finally {
      libPrisma.$queryRaw = original;
    }
    check('when the database fails, a fail-closed limit REFUSES', closed?.allowed === false && closed?.unavailable === true);
    check('and says it is unavailable, not that a quota was reached', (thrown as { status?: number; code?: string })?.code === 'internal_error');
    check('an ordinary limit still fails open (unchanged for the rest of the app)', open?.allowed === true);

    const denyThrown = (() => { try { assertWithinLimits({ allowed: false, remaining: 0, retryAfterSeconds: 5 }); } catch (error) { return error as { status?: number }; } return null; })();
    check('a real quota refusal is still a 429', denyThrown?.status === 429);

    // And the routes' own limits still hold, sequentially (existing behaviour).
    const route = await make('route-limit');
    const routeClient = await signIn(route);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await routeClient.json('/api/auth/verify-current-email', { code: '123456' }, 'PUT')).status);
    check('confirming a code is limited to ten attempts per window (then 429)', statuses.slice(0, 10).every((s) => s === 422) && statuses.slice(10).every((s) => s === 429), statuses.join(','));
  }

  // --- 14. A failed send leaves nothing usable --------------------------------
  section('14. Mail delivery failure');
  {
    const failing = async () => { throw new Error('provider unavailable'); };
    const user = await make('mailfail');
    let seen = '';
    const attempt = (send: (m: { to: string; subject: string; text: string }) => Promise<{ delivered: boolean; driver: 'resend' | 'console' }>, cooldownSeconds = 0) =>
      issueAndSendCode({
        userId: user.id,
        purpose: PURPOSE,
        address: user.email,
        ipAddress: null,
        cooldownSeconds,
        label: 'test',
        message: (code) => { seen = code; return { to: user.email, subject: 's', text: `code ${code}` }; },
        send,
      });

    const error1 = await caught(() => attempt(failing));
    check('a send that throws is reported as a server error', error1?.status === 500 && error1?.code === 'internal_error');
    check('without leaking the provider\'s message or the code', !!error1 && !(error1.message ?? '').includes('provider') && !(error1.message ?? '').includes(seen));
    check('no usable code is left behind', (await liveTokens(user.id)).length === 0);
    check('the code that was never delivered cannot be used', !(await verify(user, seen)).ok);

    const retry = await attempt(async () => ({ delivered: true, driver: 'resend' }), 60);
    check('a retry inside the cooldown does not report a send', retry.status === 'cooldown' && !retry.live);
    check('and sends nothing new', (await prisma.emailVerificationToken.count({ where: { userId: user.id, purpose: PURPOSE } })) === 1);

    await prisma.emailVerificationToken.updateMany({ where: { userId: user.id, purpose: PURPOSE }, data: { createdAt: new Date(Date.now() - 61_000) } });
    const later = await attempt(async () => ({ delivered: true, driver: 'resend' }), 60);
    check('once the cooldown has passed, a retry sends', later.status === 'sent' && (await liveTokens(user.id)).length === 1);

    // "Not delivered" with a real mail driver is a failure too.
    const strict = await make('mailstrict');
    const originalDriver = process.env.MAIL_DRIVER;
    process.env.MAIL_DRIVER = 'resend';
    const strictError = await caught(() =>
      issueAndSendCode({
        userId: strict.id, purpose: PURPOSE, address: strict.email, ipAddress: null, label: 'test',
        message: (code) => ({ to: strict.email, subject: 's', text: code }),
        send: async () => ({ delivered: false, driver: 'console' }),
      }),
    ).finally(() => { process.env.MAIL_DRIVER = originalDriver; });
    check('with a real mail driver, "not delivered" fails and withdraws the code', strictError?.status === 500 && (await liveTokens(strict.id)).length === 0);

    // A failure must not burn a newer request's code.
    const racerUser = await make('mailrace');
    const interloper: { newer: { code: string; tokenId: string } | null } = { newer: null };
    await caught(() =>
      issueAndSendCode({
        userId: racerUser.id, purpose: PURPOSE, address: racerUser.email, ipAddress: null, label: 'test',
        message: (code) => ({ to: racerUser.email, subject: 's', text: code }),
        send: async () => {
          // While this request is sending, another one gets in and issues a newer code.
          interloper.newer = await issue(racerUser);
          throw new Error('provider unavailable');
        },
      }),
    );
    const survivors = await liveTokens(racerUser.id);
    check('a failed send does not invalidate a newer request\'s code', survivors.length === 1 && survivors[0].id === interloper.newer?.tokenId);
    check('and the newer code still verifies', interloper.newer !== null && (await verify(racerUser, interloper.newer.code)).ok);

    // retiring a code is by id and only while unspent
    const spentUser = await make('mailspent');
    const spent = await issue(spentUser);
    await verify(spentUser, spent.code);
    await invalidateCode(spent.tokenId);
    check('retiring a code that was already spent does nothing', (await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: spent.tokenId } })).attempts === 1);

    // Over HTTP: a locked-out code still enforces the cooldown, and never reads as "sent".
    const lockedOut = await make('lockedout');
    const lockedClient = await signIn(lockedOut);
    await lockedClient.post('/api/auth/verify-current-email');
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) await lockedClient.json('/api/auth/verify-current-email', { code: '000000' }, 'PUT');
    const tooSoon = await lockedClient.post('/api/auth/verify-current-email');
    const tooSoonBody = await body<{ error?: string; ok?: boolean }>(tooSoon);
    check('asking again straight after a lock-out is a 429, not a false "sent"', tooSoon.status === 429 && tooSoonBody.ok !== true, `status ${tooSoon.status}`);
    check('and says how long to wait', /wait \d+ seconds/.test(tooSoonBody.error ?? ''));
    await prisma.emailVerificationToken.updateMany({ where: { userId: lockedOut.id, purpose: PURPOSE }, data: { createdAt: new Date(Date.now() - 61_000) } });
    check('after the cooldown a new code can be requested', (await lockedClient.post('/api/auth/verify-current-email')).status === 200);
  }

  // --- 15. Resending ----------------------------------------------------------
  section('15. Resending invalidates the old code');
  {
    const user = await make('resend');
    const client = await signIn(user);
    const first = await issue(user);
    const second = await issue(user);
    const old = await verify(user, first.code);
    check('the earlier code stops working the moment a new one is issued', !old.ok);
    const oldOverHttp = await client.json('/api/auth/verify-current-email', { code: first.code }, 'PUT');
    check('over HTTP too (422)', oldOverHttp.status === 422, `status ${oldOverHttp.status}`);
    check('while the new code works', (await client.json('/api/auth/verify-current-email', { code: second.code }, 'PUT')).status === 200);
  }

  // --- 16. Correct and incorrect submissions racing ---------------------------
  section('16. Correct and incorrect submissions racing');
  {
    let wins = 0;
    let broken = 0;
    for (let round = 0; round < 25; round += 1) {
      const racer = await make(`race${round}`);
      const { code, tokenId } = await issue(racer);
      const guesses = [verify(racer, code), ...Array.from({ length: 8 }, () => verify(racer, wrongFor(code)))];
      // Shuffle the arrival order of the single correct submission among the wrong ones.
      const outcomes = await Promise.all(guesses.sort(() => Math.random() - 0.5));
      const oks = outcomes.filter((o) => o.ok).length;
      const token = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: tokenId } });
      const evaluated = token.attempts;
      if (oks > 1 || evaluated > OTP_MAX_ATTEMPTS || token.consumedAt === null) broken += 1;
      wins += oks;
    }
    check('across 25 rounds of 1 correct + 8 wrong in parallel: never more than one success', broken === 0, `${broken} rounds broke an invariant`);
    check('never more than five guesses evaluated, and the code is always spent or burned', broken === 0);
    check('and the correct code does win when it arrives within the allowance', wins >= 1, `${wins} wins`);
  }

  // --- 17. Atomic claim, and failures roll back ---------------------------------
  section('17. Spending a code and acting on it are one step');
  {
    const user = await make('atomic');
    const first = await issue(user);
    let threw = false;
    try {
      await verifyCode({ userId: user.id, code: first.code, purpose: PURPOSE, address: user.email, onClaim: async () => { throw new Error('simulated failure after the claim'); } });
    } catch { threw = true; }
    const afterFailure = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: first.tokenId } });
    check('if the follow-up step fails, the error reaches the caller', threw);
    check('and the code is NOT spent', afterFailure.consumedAt === null);
    check('though the attempt it used is still counted', afterFailure.attempts === 1);
    let ran = 0;
    const retry = await verifyCode({ userId: user.id, code: first.code, purpose: PURPOSE, address: user.email, onClaim: async () => { ran += 1; } });
    check('the student can simply try again, and it works', retry.ok && ran === 1);
    const replay = await verifyCode({ userId: user.id, code: first.code, purpose: PURPOSE, address: user.email, onClaim: async () => { ran += 1; } });
    check('a replay is refused and the follow-up step does not run again', !replay.ok && ran === 1);

    // Issuing is atomic too: a failure inside the transaction leaves the old code untouched.
    const holder = await make('issue-rollback', {}, 'gmail.com');
    const kept = await issue(holder, 'email_change', `${PREFIX}+rb-old@${COLLEGE}`);
    let issueThrew = false;
    try {
      await issueCode({
        userId: holder.id, purpose: 'email_change', address: `${PREFIX}+rb-new@${COLLEGE}`, ipAddress: null,
        inTransaction: async (tx) => {
          await tx.user.update({ where: { id: holder.id }, data: { pendingEmail: `${PREFIX}+rb-new@${COLLEGE}` } });
          throw new Error('simulated failure while issuing');
        },
      });
    } catch { issueThrew = true; }
    const live = await liveTokens(holder.id, 'email_change');
    check('a failure while issuing rolls everything back', issueThrew && (await fresh(holder.id)).pendingEmail === null);
    check('the earlier code is still the one in force', live.length === 1 && live[0].id === kept.tokenId);
    check('and nothing from the failed issue is left behind — no extra code row', (await prisma.emailVerificationToken.count({ where: { userId: holder.id, purpose: 'email_change' } })) === 1);

    // The database failing mid-verification fails safely.
    const dbUser = await make('dbfail');
    const issuedForDb = await issue(dbUser);
    const original = libPrisma.$queryRaw;
    libPrisma.$queryRaw = async () => { throw new Error('simulated database failure'); };
    let verifyThrew = false;
    try { await verify(dbUser, issuedForDb.code); } catch { verifyThrew = true; } finally { libPrisma.$queryRaw = original; }
    const afterDb = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: issuedForDb.tokenId } });
    check('a database failure while verifying is an error, never a success', verifyThrew);
    check('and spends nothing and counts nothing', afterDb.consumedAt === null && afterDb.attempts === 0);

    // Over HTTP: marking the account and spending the code happen together.
    const pending = await make('keeps-pending', { pendingEmail: `${PREFIX}+kept@${COLLEGE}` });
    await grant(pending.id);
    const pendingClient = await signIn(pending);
    const sessionBefore = await prisma.session.findFirstOrThrow({ where: { userId: pending.id, status: 'ACTIVE' }, select: { id: true } });
    const code = await issue(pending);
    const done = await pendingClient.json('/api/auth/verify-current-email', { code: code.code }, 'PUT');
    const after = await fresh(pending.id);
    check('verifying the current address succeeds', done.status === 200);
    check('and leaves the email and the proposed address exactly as they were', after.email === pending.email && after.pendingEmail === `${PREFIX}+kept@${COLLEGE}` && after.emailVerifiedAt instanceof Date);
    check('and the entitlement and the session', (await prisma.entitlement.count({ where: { userId: pending.id } })) === 1 && (await prisma.session.findFirstOrThrow({ where: { userId: pending.id, status: 'ACTIVE' }, select: { id: true } })).id === sessionBefore.id);
  }

  // --- 18. The harness refuses unapproved targets ---------------------------------
  section('18. This suite refuses Neon, Production and unknown targets');
  {
    const verdict = (env: Record<string, string | undefined>) => evaluateTestTarget(env);
    const GOOD = 'postgresql://u:p@127.0.0.1:54340/localtest';
    const approved = { VERIFY_DISPOSABLE_DB: 'localtest' };
    const ok = verdict({ DATABASE_URL: GOOD, ...approved });
    check('a loopback test database that was explicitly approved is accepted', ok.ok && ok.database === 'localtest');
    check('an IPv6 loopback test database is accepted too', verdict({ DATABASE_URL: 'postgresql://u:p@[::1]:5432/scratch_db', VERIFY_DISPOSABLE_DB: 'scratch_db' }).ok);
    check('harmless parameters (sslmode, connect_timeout, application_name) are accepted', verdict({ DATABASE_URL: `${GOOD}?sslmode=disable&connect_timeout=5&application_name=tests`, ...approved }).ok);

    // Reserved (.invalid, RFC 2606) and documentation (TEST-NET) names only: a guard failure
    // must never be able to reach a real host.
    const refused: [string, Record<string, string | undefined>][] = [
      ['a Neon pooled host', { DATABASE_URL: 'postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.invalid/neondb', VERIFY_DISPOSABLE_DB: 'neondb' }],
      ['a Neon direct host with a test-looking name', { DATABASE_URL: 'postgresql://u:p@ep-x.us-east-2.aws.neon.invalid/neon_test', VERIFY_DISPOSABLE_DB: 'neon_test' }],
      ['a production-looking host', { DATABASE_URL: 'postgresql://u:p@db.cookienotes.invalid:5432/cookie_notes', VERIFY_DISPOSABLE_DB: 'cookie_notes' }],
      ['an unknown remote host with a test-looking name', { DATABASE_URL: 'postgresql://u:p@203.0.113.9:5432/app_test', VERIFY_DISPOSABLE_DB: 'app_test' }],
      ['no DATABASE_URL at all', { DATABASE_URL: undefined, ...approved }],
      ['an unparseable URL', { DATABASE_URL: 'not a url', VERIFY_DISPOSABLE_DB: 'x' }],
      ['a loopback host with a real-environment name', { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/neondb', VERIFY_DISPOSABLE_DB: 'neondb' }],
      ['a loopback host whose name does not say it is disposable', { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/studentsdb', VERIFY_DISPOSABLE_DB: 'studentsdb' }],
      ['a loopback test database that nobody approved', { DATABASE_URL: GOOD, VERIFY_DISPOSABLE_DB: undefined }],
      ['an approval that names a different database', { DATABASE_URL: GOOD, VERIFY_DISPOSABLE_DB: 'othertest' }],
      ['a server URL supplied from outside (even on loopback)', { DATABASE_URL: GOOD, ...approved, VERIFY_BASE_URL: 'http://localhost:3400' }],
      ['a remote server URL', { DATABASE_URL: GOOD, ...approved, VERIFY_BASE_URL: 'https://cookienotes.invalid' }],
      // The reported bypass, and its relatives: the host written in the URL is loopback, but a
      // parameter sends the driver somewhere else.
      ['the reported bypass: ?host= pointing at a Neon host', { DATABASE_URL: `${GOOD}?host=ep-fake.us-east-2.aws.neon.invalid`, ...approved }],
      ['?hostaddr= pointing at a remote address', { DATABASE_URL: `${GOOD}?hostaddr=203.0.113.9`, ...approved }],
      ['?HOST= in capitals', { DATABASE_URL: `${GOOD}?HOST=db.example.invalid`, ...approved }],
      ['?host= that is itself loopback (still an override)', { DATABASE_URL: `${GOOD}?host=127.0.0.1`, ...approved }],
      ['a unix-socket ?host=', { DATABASE_URL: `${GOOD}?host=/var/run/postgresql`, ...approved }],
      ['?port=', { DATABASE_URL: `${GOOD}?port=5432`, ...approved }],
      ['?options=', { DATABASE_URL: `${GOOD}?options=-c%20search_path%3Dpublic`, ...approved }],
      ['?service=', { DATABASE_URL: `${GOOD}?service=production`, ...approved }],
      ['?dbname=', { DATABASE_URL: `${GOOD}?dbname=neondb`, ...approved }],
      ['?user= and ?password=', { DATABASE_URL: `${GOOD}?user=admin&password=x`, ...approved }],
      ['an allowed parameter alongside an overriding one', { DATABASE_URL: `${GOOD}?sslmode=disable&host=db.example.invalid`, ...approved }],
      ['a repeated host parameter', { DATABASE_URL: `${GOOD}?host=127.0.0.1&host=db.example.invalid`, ...approved }],
      ['user-info that looks like a loopback host', { DATABASE_URL: 'postgresql://127.0.0.1@ep-fake.us-east-2.aws.neon.invalid/localtest', ...approved }],
      ['a host that merely starts with a loopback address', { DATABASE_URL: 'postgresql://u:p@127.0.0.1.example.invalid/localtest', ...approved }],
      ['a multi-host URL', { DATABASE_URL: 'postgresql://u:p@127.0.0.1,db.example.invalid/localtest', ...approved }],
      ['a trailing-dot hostname', { DATABASE_URL: 'postgresql://u:p@localhost./localtest', ...approved }],
    ];
    for (const [label, env] of refused) {
      const v = verdict(env);
      check(`refused: ${label}`, !v.ok && v.reasons.length > 0);
      check('   and the reasons never contain the URL, a host or a password', !JSON.stringify(v.reasons).match(/:p@|:x\b|ep-x|ep-fake|neon\.invalid|203\.0\.113|cookienotes|example\.invalid|127\.0\.0\.1|search_path|production/));
    }
    check('every parameter the guard allows is on its published allow-list', [...ALLOWED_QUERY_PARAMETERS].sort().join(',') === 'application_name,connect_timeout,sslmode');
    check('a database holding real-looking data fails the identity check', evaluateDatabaseIdentity({ database: 'localtest', serverAddress: '127.0.0.1', foreignUsers: 340 }, 'localtest').length > 0);
    check('a different database fails it', evaluateDatabaseIdentity({ database: 'neondb', serverAddress: '127.0.0.1', foreignUsers: 0 }, 'localtest').length > 0);
    check('a remote server fails it', evaluateDatabaseIdentity({ database: 'localtest', serverAddress: '10.0.0.5', foreignUsers: 0 }, 'localtest').length > 0);
    check('a nearly empty local database passes it', evaluateDatabaseIdentity({ database: 'localtest', serverAddress: null, foreignUsers: 3 }, 'localtest').length === 0);

    // The script itself, run for real. Refusal must come BEFORE any connection: a listener on
    // loopback records every connection attempt, so "nothing was written" is observed, not assumed.
    const script = process.argv[1];
    const secret = 'SuperSecretPassw0rd';
    const runChild = (env: Record<string, string>) =>
      new Promise<{ status: number | null; out: string }>((resolve) => {
        // NODE_OPTIONS is cleared so only the suite's own guard is being tested, not the harness around it.
        const child = spawn('npx', ['tsx', script], { env: { ...process.env, NODE_OPTIONS: '', VERIFY_DISPOSABLE_DB: '', VERIFY_BASE_URL: '', ...env } });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
        child.on('exit', (status) => { clearTimeout(timer); resolve({ status, out }); });
      });

    let connections = 0;
    const listener = createTcpServer((socket) => { connections += 1; socket.destroy(); });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

    const bypass = await runChild({ DATABASE_URL: `postgresql://app:${secret}@127.0.0.1:5432/localtest?host=127.0.0.1&port=${port}`, VERIFY_DISPOSABLE_DB: 'localtest' });
    await settle();
    check('the script, given the ?host=/?port= bypass, exits with the refusal code (3)', bypass.status === 3, `exit ${bypass.status}`);
    check('says it refused, and names the parameters (not their values)', /REFUSING TO RUN/.test(bypass.out) && /host, port/.test(bypass.out));
    check('and made NO connection at all — nothing could have been written', connections === 0, `${connections} connection(s)`);
    check('without printing the password or the connection string', !bypass.out.includes(secret) && !bypass.out.includes(`:${port}`));

    const hostaddr = await runChild({ DATABASE_URL: `postgresql://app:${secret}@127.0.0.1:${port}/localtest?hostaddr=127.0.0.1`, VERIFY_DISPOSABLE_DB: 'localtest' });
    await settle();
    check('the same for ?hostaddr=', hostaddr.status === 3 && connections === 0, `exit ${hostaddr.status}, ${connections} connection(s)`);

    const external = await runChild({ DATABASE_URL: `postgresql://app:${secret}@127.0.0.1:${port}/localtest`, VERIFY_DISPOSABLE_DB: 'localtest', VERIFY_BASE_URL: 'http://localhost:3400' });
    await settle();
    check('an externally supplied server URL is refused before any connection', external.status === 3 && connections === 0 && /VERIFY_BASE_URL/.test(external.out));

    // Control: a clean, approved URL is NOT refused by the guard — the script does try to connect
    // (the listener sees it) — so the zero counts above mean something.
    const control = await runChild({ DATABASE_URL: `postgresql://app:${secret}@127.0.0.1:${port}/localtest`, VERIFY_DISPOSABLE_DB: 'localtest' });
    await settle();
    check('control: an approved URL is accepted by the guard and the script tries to connect', connections >= 1 && control.status !== 3, `exit ${control.status}, ${connections} connection(s)`);
    check('control: and even then it never printed the password', !control.out.includes(secret));
    await new Promise<void>((resolve) => listener.close(() => resolve()));

    const neon = await runChild({ DATABASE_URL: `postgresql://neondb_owner:${secret}@ep-fake-1234-pooler.us-east-2.aws.neon.invalid/neondb?sslmode=require` });
    check('the script, given a Neon-looking URL, exits with the refusal code (3)', neon.status === 3, `exit ${neon.status}`);
    check('says it refused, and why', /REFUSING TO RUN/.test(neon.out) && /Neon/.test(neon.out));
    check('never prints the connection string, host or password', !neon.out.includes(secret) && !neon.out.includes('ep-fake-1234') && !neon.out.includes('neon.invalid'));
    check('and runs no tests', !/checks passed|✓/.test(neon.out));
    const none = await runChild({ DATABASE_URL: '' });
    check('the script, given no URL, refuses too', none.status === 3 && /REFUSING TO RUN/.test(none.out));
    const prod = await runChild({ DATABASE_URL: `postgresql://app:${secret}@db.cookienotes.invalid:5432/cookie_notes`, VERIFY_DISPOSABLE_DB: 'cookie_notes' });
    check('the script, given a production-looking URL, refuses', prod.status === 3 && !prod.out.includes(secret));
  }

  // --- 19. The signing secret is required ------------------------------------
  section('19. Without the signing secret, codes are refused (no weaker fallback)');
  {
    const user = await make('nosecret');
    const existing = await issue(user); // a code already on file, issued while the secret was available
    const saved = process.env.AUTH_SECRET;
    const sent: string[] = [];
    const outcomes: { missing?: string; short?: string; verifyMissing?: string } = {};
    try {
      delete process.env.AUTH_SECRET;
      outcomes.missing = (await caught(() => issue(user)))?.message;
      const viaHelper = await caught(() =>
        issueAndSendCode({
          userId: user.id, purpose: PURPOSE, address: user.email, ipAddress: null, label: 'test',
          message: (code) => { sent.push(code); return { to: user.email, subject: 's', text: code }; },
          send: async (m) => { sent.push(m.text); return { delivered: true, driver: 'resend' }; },
        }),
      );
      outcomes.verifyMissing = (await caught(() => verify(user, existing.code)))?.message;
      process.env.AUTH_SECRET = 'too-short';
      outcomes.short = (await caught(() => issue(user)))?.message;
      check('issuing with no AUTH_SECRET refuses', /unavailable/i.test(outcomes.missing ?? ''), outcomes.missing);
      check('and so does the send helper — no email is ever composed or sent', Boolean(viaHelper) && sent.length === 0);
      check('verifying a real code with no AUTH_SECRET refuses — it is never accepted', /unavailable/i.test(outcomes.verifyMissing ?? ''), outcomes.verifyMissing);
      check('a secret that is too short is refused too', /unavailable/i.test(outcomes.short ?? ''), outcomes.short);
      check('and none of those attempts wrote or spent a code', (await prisma.emailVerificationToken.count({ where: { userId: user.id } })) === 1 && (await liveTokens(user.id)).length === 1);
    } finally {
      process.env.AUTH_SECRET = saved;
    }
    check('with the secret back, the code that was on file verifies', (await verify(user, existing.code)).ok);
    check('and issuing works again', (await issue(user)).status === 'issued');
  }

  // --- 20. A confirmation racing a new proposal -------------------------------------
  section('20. A confirmation racing a new proposal cannot deadlock');
  {
    const { prisma: appPrisma } = await import('../src/lib/prisma');
    const ROUNDS = 200;
    const isDeadlock = (error: unknown) =>
      /deadlock|write conflict|40P01|P2034/i.test(`${(error as Error)?.message ?? ''} ${(error as { code?: string })?.code ?? ''}`);

    /** What issueCode did BEFORE the fix: the proposal first, then the token statements. The control. */
    const issueProposalFirst = (userId: string, address: string) =>
      appPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`otp:${userId}:email_change`}, 0))`;
        await tx.user.update({ where: { id: userId }, data: { pendingEmail: address } });
        await tx.emailVerificationToken.updateMany({ where: { userId, purpose: 'email_change', consumedAt: null }, data: { consumedAt: new Date() } });
        const code = otp.generateCode();
        await tx.emailVerificationToken.create({
          data: { userId, purpose: 'email_change', codeHash: hashCode(code, { userId, purpose: 'email_change', address }), expiresAt: new Date(Date.now() + 600_000) },
        });
        return { code };
      });

    /**
     * One round is exactly the pair of requests that collide: the student confirms a code
     * (verifyCode + the move, as PUT /api/auth/college-email does) at the same moment they
     * submit a new proposal (issueCode + pendingEmail, as POST does).
     */
    const runRounds = async (tag: string, proposalFirst: boolean) => {
      let deadlocks = 0;
      let otherErrors = 0;
      let inconsistent = 0;
      for (let i = 0; i < ROUNDS; i += 1) {
        const B = `${PREFIX}+dl-${tag}-${i}-b@${COLLEGE}`;
        const C = `${PREFIX}+dl-${tag}-${i}-c@${COLLEGE}`;
        const racer = await prisma.user.create({ data: { email: `${PREFIX}+dl-${tag}-${i}@gmail.test`, name: 'Race', passwordHash, pendingEmail: B } });
        const first = await issueCode({ userId: racer.id, purpose: 'email_change', address: B, ipAddress: null });

        const confirm = verifyCode({
          userId: racer.id, code: first.code, purpose: 'email_change', address: B,
          onClaim: async (tx) => {
            await tx.user.updateMany({
              where: { id: racer.id, pendingEmail: B, emailVerifiedAt: null },
              data: { email: `${PREFIX}+dl-${tag}-${i}-moved@${COLLEGE}`, emailVerifiedAt: new Date(), pendingEmail: null },
            });
          },
        });
        const propose: Promise<{ code: string }> = proposalFirst
          ? issueProposalFirst(racer.id, C)
          : issueCode({
              userId: racer.id, purpose: 'email_change', address: C, ipAddress: null,
              inTransaction: async (tx) => { await tx.user.update({ where: { id: racer.id }, data: { pendingEmail: C } }); },
            });

        const [confirmed, proposed] = await Promise.allSettled([confirm, propose]);
        for (const outcome of [confirmed, proposed]) {
          if (outcome.status === 'rejected') {
            if (isDeadlock(outcome.reason)) deadlocks += 1;
            else otherErrors += 1;
          }
        }
        if (confirmed.status === 'fulfilled' && proposed.status === 'fulfilled') {
          // Whatever the order, the end state must make sense.
          const now = await fresh(racer.id);
          const live = await liveTokens(racer.id, 'email_change');
          const moved = confirmed.value.ok;
          const proposalHeld = now.pendingEmail === C && live.length === 1 && live[0].codeHash === hashCode(proposed.value.code, { userId: racer.id, purpose: 'email_change', address: C });
          const consistent = live.length <= 1 && (moved ? now.email.endsWith(`-moved@${COLLEGE}`) && now.emailVerifiedAt !== null : proposalHeld);
          if (!consistent) inconsistent += 1;
        }
      }
      return { deadlocks, otherErrors, inconsistent };
    };

    const control = await runRounds('old', true);
    check(`control: the pre-fix lock order DOES deadlock under this harness (${control.deadlocks} deadlocks in ${ROUNDS} rounds)`, control.deadlocks >= 1);
    for (const batch of ['a', 'b']) {
      const fixed = await runRounds(batch, false);
      check(`fixed order, batch ${batch}: no deadlocks in ${ROUNDS} concurrent rounds`, fixed.deadlocks === 0, `${fixed.deadlocks} deadlocks`);
      check(`fixed order, batch ${batch}: no other errors from either request`, fixed.otherErrors === 0, `${fixed.otherErrors} errors`);
      check(`fixed order, batch ${batch}: every round ended in a consistent state`, fixed.inconsistent === 0, `${fixed.inconsistent} inconsistent`);
    }
  }

  // --- 21. The server under test is verified -----------------------------------------
  section('21. The server under test is verified, or nothing runs');
  {
    check('the suite is talking to its own server, on loopback', BASE_URL.startsWith('http://127.0.0.1:') && BASE_URL === ownedServer?.baseUrl);
    check('and that server was shown to be using the approved database', await confirmServerUsesDatabase(BASE_URL, handshakeProbe));

    // A server that answers but never records anything in the approved database — which is what a
    // server connected to some OTHER database looks like from here — must not pass.
    const silent = createHttpServer((_req, res) => { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end('{"error":"unauthorized"}'); });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const silentPort = (silent.address() as { port: number }).port;
    check('a server that writes nothing to the approved database FAILS the handshake (fail closed)', !(await confirmServerUsesDatabase(`http://127.0.0.1:${silentPort}`, handshakeProbe, { timeoutMs: 1500 })));
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    check('so does a server that is not there at all', !(await confirmServerUsesDatabase(`http://127.0.0.1:${silentPort}`, handshakeProbe, { timeoutMs: 1000 })));
    check('and a probe that errors is a failure, not a pass', !(await confirmServerUsesDatabase(BASE_URL, { countMarker: async () => { throw new Error('probe failed'); } }, { timeoutMs: 1000 })));

    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const emptyProject = mkdtempSync(`${tmpdir()}/no-build-`);
    const noBuild = await caught(() => startOwnedServer({ databaseUrl: process.env.DATABASE_URL!, authSecret: 'x'.repeat(32), projectDir: emptyProject }));
    check('without a production build there is no server, and the suite stops', /no production build/i.test(noBuild?.message ?? ''), noBuild?.message);
    const shortSecret = await caught(() => startOwnedServer({ databaseUrl: process.env.DATABASE_URL!, authSecret: 'short' }));
    check('a server will not start without a usable AUTH_SECRET', /AUTH_SECRET/.test(shortSecret?.message ?? ''), shortSecret?.message);
  }

  await cleanup();

  console.log(`\n${'─'.repeat(56)}`);
  if (failed === 0) {
    console.log(`\x1b[32m${passed} checks passed.\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m${passed} passed, ${failed} failed:\x1b[0m`);
    failures.forEach((name) => console.log(`  • ${name}`));
    console.log();
    process.exitCode = 1;
  }
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    await cleanup().catch(() => undefined);
  })
  .finally(async () => {
    await ownedServer?.stop();
    await prisma.$disconnect();
  });
