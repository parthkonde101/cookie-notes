/**
 * Verifies "Verify my current email" — the path for an existing student whose
 * address is already on the college domain — and that the migration path for
 * everyone else still works.
 *
 *   npm run build && npm run start        # in one terminal
 *   npm run verify:current-email          # in another
 *
 * Runs against a real HTTP server with real cookies and a real database. The
 * emailed code cannot be read from here, so where a test needs a known code it
 * is issued straight through `issueCode` (the same function the route uses);
 * where the route's own behaviour is what is being tested — sending, cooldown,
 * rate limits, what it does with a body — the route is called.
 *
 * Fixtures are prefixed `curtest+`, use their own fake client addresses, and are
 * removed before and after. NEVER point this at a database that holds real
 * students: it creates and deletes accounts.
 */
import 'dotenv/config';

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

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';
const PREFIX = 'curtest';
const PASSWORD = 'Current-Email-2026!';
const COLLEGE = 'mitwpu.edu.in';
/** Documentation-range addresses, so cleanup can never touch another suite's rate-limit rows. */
const IP_PREFIX = '198.51.100.';

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

async function main() {
  console.log(`\nVerifying "Verify my current email"\n${'─'.repeat(56)}`);
  await cleanup();

  const otp = await import('../src/lib/auth/otp');
  const { issueCode, verifyCode, OTP_PURPOSE, OTP_MAX_ATTEMPTS, OTP_TTL_MINUTES } = otp;
  const { canVerifyCurrentEmail } = await import('../src/lib/auth/current-email');
  const { needsEmailMigration } = await import('../src/lib/auth/guards');
  const { featuredTestimonials } = await import('../src/lib/testimonials');

  const PURPOSE = OTP_PURPOSE.currentEmail;
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
    const { code } = await issueCode(student.id, null, PURPOSE);
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
    const { code } = await issueCode(expired.id, null, PURPOSE);
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
    const spent = await issueCode(reuse.id, null, PURPOSE);
    const first = await reuseClient.json('/api/auth/verify-current-email', { code: spent.code }, 'PUT');
    check('(setup) the first use succeeds', first.status === 200);
    // Put the account back to unverified so a replay reaches the code check rather than the idempotent shortcut.
    await prisma.user.update({ where: { id: reuse.id }, data: { emailVerifiedAt: null } });
    const replay = await reuseClient.json('/api/auth/verify-current-email', { code: spent.code }, 'PUT');
    check('a used code cannot be used again (422)', replay.status === 422, `status ${replay.status}`);
    check('and the replay did not verify the account', (await fresh(reuse.id)).emailVerifiedAt === null);

    const locked = await make('locked');
    const lockedClient = await signIn(locked);
    const lockedCode = await issueCode(locked.id, null, PURPOSE);
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
    const relock = await issueCode(locked.id, null, PURPOSE);
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
    const ownerCode = await issueCode(owner.id, null, PURPOSE);
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
    const migrationCode = await issueCode(mixed.id, null, 'email_change');
    const wrongPurpose = await mixedClient.json('/api/auth/verify-current-email', { code: migrationCode.code }, 'PUT');
    check('an address-change code cannot verify the current address', wrongPurpose.status === 422, `status ${wrongPurpose.status}`);
    check('and was not consumed by the attempt', (await liveTokens(mixed.id, 'email_change'))[0]?.attempts === 0);
    check('the account stayed unverified', (await fresh(mixed.id)).emailVerifiedAt === null);

    const currentCode = await issueCode(mixed.id, null, PURPOSE);
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
    const { code } = await issueCode(racer.id, null, PURPOSE);
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
    const twinCode = await issueCode(twin.id, null, PURPOSE);
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => verifyCode(twin.id, twinCode.code, PURPOSE)));
    check('twelve simultaneous verifyCode calls: exactly one returns ok', outcomes.filter((o) => o.ok).length === 1, JSON.stringify(outcomes.map((o) => (o.ok ? 'ok' : o.reason))));

    const flood = await make('flood');
    const floodCode = await issueCode(flood.id, null, PURPOSE);
    await Promise.all(Array.from({ length: 40 }, () => verifyCode(flood.id, wrongFor(floodCode.code), PURPOSE)));
    const floodToken = await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: flood.id, purpose: PURPOSE } });
    check('forty simultaneous wrong guesses are held to the allowance', floodToken.attempts === OTP_MAX_ATTEMPTS, `attempts ${floodToken.attempts}`);
    check('and burn the code', floodToken.consumedAt !== null);
    check('so the real code no longer works', !(await verifyCode(flood.id, floodCode.code, PURPOSE)).ok);
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

    const { code } = await issueCode(legacy.id, null, 'email_change');
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

    const { code } = await issueCode(typo.id, null, 'email_change');
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
  .finally(() => prisma.$disconnect());
