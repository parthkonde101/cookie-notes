/**
 * Verifies simple registration — EMAIL_VERIFICATION_REQUIRED off, the default —
 * the watermark being off, and that switching both back on restores the previous
 * behaviour.
 *
 *   npm run build
 *   DATABASE_URL=<local test db> VERIFY_DISPOSABLE_DB=<its name> AUTH_SECRET=<16+ chars> \
 *     npm run verify:no-verification
 *
 * The suite starts its OWN production servers (`next start` on free loopback
 * ports) against exactly the database it has approved — verification off,
 * unset, on, and set to an unrecognised value — and proves each is using that
 * database before any test runs. It never talks to a server you started, and
 * VERIFY_BASE_URL must not be set.
 *
 * It creates and deletes accounts, notes and rate-limit rows, so it REFUSES TO
 * RUN unless the database is a disposable local one you have named in
 * VERIFY_DISPOSABLE_DB (scripts/lib/disposable-db.ts). It will not run against
 * Neon, Production, or whatever `.env` happens to point at.
 *
 * Fixtures are prefixed `novtest+` / `[novtest]` and are removed before and after.
 */
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateDatabaseIdentity, evaluateTestTarget } from './lib/disposable-db';
import { confirmServerUsesDatabase, startOwnedServer, type OwnedServer } from './lib/test-server';

const targetVerdict = evaluateTestTarget(process.env);
if (!targetVerdict.ok) {
  console.error('\nREFUSING TO RUN — this suite only runs against an approved, disposable local database:');
  for (const reason of targetVerdict.reasons) console.error(`  • ${reason}`);
  console.error('\nNothing was connected to and nothing was changed.\n');
  process.exit(3);
}

// Modules marked `server-only` throw outside a React Server Component; neutralise the marker.
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {} } as NodeJS.Module;

import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const PREFIX = 'novtest';
const PASSWORD = 'No-Verification-2026!';
/** Documentation-range addresses (TEST-NET-3), so cleanup can never touch another suite's rows. */
const IP_PREFIX = '203.0.113.';
const REGISTER_LIMIT = 6;

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

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
const section = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);

let ipCounter = 10;
let BASE_URL = '';

/** A browser-ish client with its own cookie jar and its own fake network address. */
class Client {
  private cookies = new Map<string, string>();
  readonly ip: string;
  constructor(ip?: string) {
    this.ip = ip ?? `${IP_PREFIX}${ipCounter++}`;
  }
  async request(path_: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    headers.set('user-agent', 'CookieNotes-Verify/no-verification');
    headers.set('x-forwarded-for', this.ip);
    const response = await fetch(`${BASE_URL}${path_}`, { ...init, headers, redirect: 'manual' });
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
  json(path_: string, payload: unknown, method = 'POST') {
    return this.request(path_, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }
  post(path_: string) {
    return this.request(path_, { method: 'POST' });
  }
  hasSession() {
    return this.cookies.has('sv_session');
  }
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}
const sha256 = (buffer: Buffer | Uint8Array) => createHash('sha256').update(buffer).digest('hex');

interface SeenPage {
  status: number;
  html: string;
  to: string | null;
  notFound: boolean;
}
/**
 * A page may redirect with a real 307 (middleware) or — once it has started
 * streaming — with a 200 whose body carries the redirect. The other suites treat
 * both as a redirect, and so does this one.
 */
async function seePage(response: Response): Promise<SeenPage> {
  const html = response.status === 200 ? await response.text() : '';
  let target: string | null = null;
  if ([301, 302, 303, 307, 308].includes(response.status)) target = response.headers.get('location');
  else if (response.status === 200) {
    target =
      /id="__next-page-redirect"[^>]*content="\d+;\s*url=([^"]+)"/.exec(html)?.[1] ??
      /NEXT_REDIRECT;[a-z]+;([^;]+);/.exec(html)?.[1] ??
      null;
  }
  let to: string | null = null;
  if (target) {
    const url = new URL(target, 'http://placeholder.invalid');
    to = url.pathname + url.search;
  }
  const notFound = response.status === 404 || (response.status === 200 && /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(html));
  return { status: response.status, html, to, notFound };
}
const goes = (page: SeenPage, prefix: string) => page.to?.startsWith(prefix) ?? false;
const makePdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n%${randomBytes(120_000).toString('base64')}\n%%EOF\n`);

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: `${PREFIX}+` } }, select: { id: true } });
  const ids = users.map((user) => user.id);
  await prisma.rateLimit.deleteMany({
    where: { OR: [{ key: { contains: IP_PREFIX } }, { key: { contains: `${PREFIX}+` } }, ...ids.map((id) => ({ key: { contains: id } }))] },
  });
  await prisma.user.deleteMany({ where: { email: { contains: `${PREFIX}+` } } });
  await prisma.subject.deleteMany({ where: { name: { startsWith: '[novtest]' } } });
  await prisma.semester.deleteMany({ where: { name: { startsWith: '[novtest]' } } });
}

const handshakeProbe = {
  countMarker: (marker: string) =>
    prisma.activityEvent.count({ where: { type: 'LOGIN_FAILED', metadata: { path: ['email'], equals: marker } } }),
};

const ownedServers: OwnedServer[] = [];

async function main() {
  console.log(`\nVerifying simple registration, no watermark, and the switch back\n${'─'.repeat(56)}`);
  const [identity] = await prisma.$queryRaw<{ db: string; addr: string | null; foreign_users: bigint }[]>`
    SELECT current_database() AS db, host(inet_server_addr()) AS addr,
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

  const authSecret = process.env.AUTH_SECRET ?? '';
  async function startServer(extraEnv: Record<string, string>): Promise<OwnedServer> {
    const server = await startOwnedServer({ databaseUrl: process.env.DATABASE_URL!, authSecret, extraEnv });
    ownedServers.push(server);
    if (!(await confirmServerUsesDatabase(server.baseUrl, handshakeProbe))) {
      throw new Error('A test server could not be shown to be using the approved database.');
    }
    return server;
  }

  await cleanup();

  // --- the setting itself, in-process ------------------------------------------
  section('1. How the settings are read');
  {
    const { readEmailVerificationSetting, env } = await import('../src/lib/env');
    const read = (value: string | undefined) => readEmailVerificationSetting(value);
    check('unset → verification OFF, from the default', !read(undefined).required && read(undefined).source === 'default');
    check('empty or blank → OFF, from the default', !read('').required && !read('   ').required && read('  ').source === 'default');
    check('"false", "FALSE", " false " and "0" → OFF', ['false', 'FALSE', ' false ', '0'].every((v) => !read(v).required && read(v).source === 'set'));
    check('"true", "TRUE", " true " and "1" → ON', ['true', 'TRUE', ' true ', '1'].every((v) => read(v).required && read(v).source === 'set'));
    check('anything else → ON, and flagged invalid (a typo can only tighten, never loosen)', ['yes', 'no', 'on', 'off', 'maybe', 'falsee', 'disabled', 'null'].every((v) => read(v).required && read(v).source === 'invalid'));
    const keepV = process.env.EMAIL_VERIFICATION_REQUIRED;
    const keepR = process.env.REGISTER_MAX_PER_HOUR;
    const limit = (verification: string, value: string | undefined) => {
      process.env.EMAIL_VERIFICATION_REQUIRED = verification;
      if (value === undefined) delete process.env.REGISTER_MAX_PER_HOUR;
      else process.env.REGISTER_MAX_PER_HOUR = value;
      return env.rateLimit.registerMaxPerHour;
    };
    check('the registration limit defaults to 100 per IP per hour while verification is off', limit('false', undefined) === 100);
    check('and to the original 10 while it is on (every attempt sends an email)', limit('true', undefined) === 10);
    check('a configured whole number is used, spaces ignored', limit('false', '250') === 250 && limit('false', ' 50 ') === 50 && limit('true', '25') === 25);
    check('a bad value (0, negative, text, blank, decimal, exponent) is ignored — it never switches the limit off', ['0', '-3', 'abc', '', '   ', '1.5', '1e3', '∞'].every((v) => limit('false', v) === 100 && limit('true', v) === 10));
    if (keepV === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED; else process.env.EMAIL_VERIFICATION_REQUIRED = keepV;
    if (keepR === undefined) delete process.env.REGISTER_MAX_PER_HOUR; else process.env.REGISTER_MAX_PER_HOUR = keepR;

    const keep = process.env.NOTE_WATERMARK_ENABLED;
    const watermark = (value: string | undefined) => {
      if (value === undefined) delete process.env.NOTE_WATERMARK_ENABLED;
      else process.env.NOTE_WATERMARK_ENABLED = value;
      return env.notes.watermark;
    };
    check('the watermark is OFF when unset, empty, "false", "yes" or anything unrecognised', [undefined, '', 'false', 'yes', 'on', '2'].every((v) => !watermark(v)));
    check('and ON only for "true" or "1"', ['true', 'TRUE', ' 1 '].every((v) => watermark(v)));
    if (keep === undefined) delete process.env.NOTE_WATERMARK_ENABLED;
    else process.env.NOTE_WATERMARK_ENABLED = keep;
  }

  // --- fixtures -------------------------------------------------------------------
  const stamp = Date.now();
  const semester = await prisma.semester.create({ data: { name: '[novtest] Sem', slug: `novtest-${stamp}`, position: 95 } });
  const subject = await prisma.subject.create({ data: { semesterId: semester.id, name: '[novtest] Subject', slug: `novtest-sub-${stamp}` } });
  const files = new Map<string, Buffer>();
  async function makeNote(label: string, visibility: 'FREE' | 'RESTRICTED') {
    const key = `notes/2026/10/novtest-${stamp}-${label}.pdf`;
    const bytes = makePdf(label);
    files.set(key, bytes);
    return prisma.note.create({
      data: { title: `[novtest] ${label}`, subjectId: subject.id, status: 'PUBLISHED', visibility, storageKey: key, fileName: `${label}.pdf`, fileSize: bytes.length, pageCount: 1 },
    });
  }
  const freeNote = await makeNote('free', 'FREE');
  const restrictedNote = await makeNote('restricted', 'RESTRICTED');
  const pyqKey = `pyqs/2026/novtest-${stamp}.pdf`;
  files.set(pyqKey, makePdf('pyq'));
  const pyq = await prisma.pyq.create({ data: { subjectId: subject.id, year: 2025, storageKey: pyqKey, fileName: 'pyq.pdf', fileSize: files.get(pyqKey)!.length } });
  const sha = (note: { storageKey: string }) => sha256(files.get(note.storageKey)!);
  async function placeFiles(server: OwnedServer) {
    for (const [key, bytes] of files) {
      const target = path.join(server.storageDir, key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const make = (name: string, extra: Record<string, unknown> = {}, domain = 'gmail.com') =>
    prisma.user.create({ data: { email: `${PREFIX}+${name}@${domain}`, name: `Nov ${name}`, passwordHash, status: 'ACTIVE', ...extra } });
  const signedIn = new Map<string, Client>();
  async function signIn(user: { email: string }) {
    const key = `${BASE_URL}|${user.email}`;
    const existing = signedIn.get(key);
    if (existing) return existing;
    const client = new Client();
    const response = await client.json('/api/auth/login', { email: user.email, password: PASSWORD });
    if (response.status !== 200) throw new Error(`could not sign ${user.email} in: ${response.status}`);
    signedIn.set(key, client);
    return client;
  }
  const row = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
  const goodRegistration = (name: string, email: string) => ({
    name, email, password: 'Sturdy-Pass-77!x', confirmPassword: 'Sturdy-Pass-77!x',
  });

  /**
   * Registration must never alter an account that already exists, in either mode.
   * Every kind of existing account is "registered over" with a different name,
   * password and details — and every one must be refused (409) with the account,
   * row for row, exactly as it was, including its last-updated time.
   */
  async function existingAccountsAreUntouched(mode: 'off' | 'on') {
    const domain = mode === 'on' ? 'mitwpu.edu.in' : 'gmail.com';
    const accounts = [
      ['a verified account', await make(`dr-verified-${mode}`, { emailVerifiedAt: new Date('2026-09-20T10:00:00Z') }, 'mitwpu.edu.in')],
      ['an account awaiting verification', await make(`dr-pending-${mode}`, { verificationRequired: true }, 'mitwpu.edu.in')],
      ['an older account with details', await make(`dr-legacy-${mode}`, { college: 'Original College', program: 'Diploma', semester: 3 }, domain)],
      ['an account with an address change in progress', await make(`dr-moving-${mode}`, { pendingEmail: `${PREFIX}+dr-next-${mode}@mitwpu.edu.in` }, domain)],
    ] as const;
    for (const [label, account] of accounts) {
      const snapshotBefore = JSON.stringify(await row(account.id));
      const tokensBefore = await prisma.emailVerificationToken.count({ where: { userId: account.id } });
      const variants = [account.email, account.email.toUpperCase(), `  ${account.email}  `];
      const answers: number[] = [];
      for (const [i, address] of variants.entries()) {
        const attack = await new Client().json('/api/auth/register', {
          name: `Overwritten ${i}`, email: address, password: 'Attacker-Pass-99!q', confirmPassword: 'Attacker-Pass-99!q',
          college: 'Evil College', program: 'Evil Program', semester: 8,
        });
        answers.push(attack.status);
        if (i === 0) {
          const text = (await body<{ error?: string }>(attack)).error ?? '';
          check(`${mode}: ${label} — the 409 says to log in or recover the password`, /log in/i.test(text) && /forgot password/i.test(text), text);
        }
      }
      check(`${mode}: ${label} — registering over it is refused (409) in every spelling`, answers.every((status) => status === 409), answers.join(','));
      check(`${mode}: ${label} — the row is byte-for-byte unchanged (password, name, verification state, details, updatedAt)`, JSON.stringify(await row(account.id)) === snapshotBefore);
      check(`${mode}: ${label} — no code was issued or sent`, (await prisma.emailVerificationToken.count({ where: { userId: account.id } })) === tokensBefore && (await prisma.activityEvent.count({ where: { userId: account.id, type: 'EMAIL_VERIFICATION_SENT' } })) === 0);
      check(`${mode}: ${label} — no second account exists`, (await prisma.user.count({ where: { email: account.email } })) === 1);
      const attacker = await new Client().json('/api/auth/login', { email: account.email, password: 'Attacker-Pass-99!q' });
      check(`${mode}: ${label} — the attacker's password does not sign in`, attacker.status === 422 || attacker.status === 403, `status ${attacker.status}`);
    }
    const verifiedOwn = await new Client().json('/api/auth/login', { email: accounts[0][1].email, password: PASSWORD });
    check(`${mode}: the owner's own password still signs in to a verified account`, verifiedOwn.status === 200, `status ${verifiedOwn.status}`);
    const pendingOwn = await new Client().json('/api/auth/login', { email: accounts[1][1].email, password: PASSWORD });
    check(
      mode === 'on'
        ? 'on: an account awaiting verification still cannot sign in (403) — it was not replaced either'
        : 'off: an account awaiting verification signs in with its original password',
      mode === 'on' ? pendingOwn.status === 403 : pendingOwn.status === 200,
      `status ${pendingOwn.status}`,
    );

    // Two simultaneous registrations of the same new address: one account, the rest refused.
    const email = `${PREFIX}+race-${mode}@${mode === 'on' ? 'mitwpu.edu.in' : 'gmail.com'}`;
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => new Client().json('/api/auth/register', goodRegistration(`Racer ${i}`, email))),
    );
    const statuses = results.map((r) => r.status).sort();
    const created = statuses.filter((status) => status === 201 || status === 202).length;
    check(`${mode}: of 4 simultaneous registrations for one address exactly one succeeds, the others get 409`, created === 1 && statuses.filter((status) => status === 409).length === 3, statuses.join(','));
    check(`${mode}: and there is one account for it`, (await prisma.user.count({ where: { email } })) === 1);
  }

  // =========================================================================
  // Server OFF: verification explicitly off; entitlements enforced; watermark default.
  // =========================================================================
  const OFF = await startServer({ EMAIL_VERIFICATION_REQUIRED: 'false', OPEN_ACCESS_MODE: 'false', REGISTER_MAX_PER_HOUR: String(REGISTER_LIMIT) });
  await placeFiles(OFF);
  BASE_URL = OFF.baseUrl;

  section('2. Registration with any email: signed in at once, no code');
  {
    const student = new Client();
    const email = `${PREFIX}+fresh@gmail.com`;
    const response = await student.json('/api/auth/register', goodRegistration('Fresh Student', email));
    const result = await body<{ ok?: boolean; redirectTo?: string; status?: string }>(response);
    check('a Gmail address registers (201)', response.status === 201 && result.ok === true, `status ${response.status}`);
    check('and is sent straight into the app', result.redirectTo === '/' && result.status === undefined);
    check('a session cookie was issued', student.hasSession());
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    check('the account is an ordinary active student', user.role === 'STUDENT' && user.status === 'ACTIVE');
    check('and its email is NOT marked verified', user.emailVerifiedAt === null);
    check('it is not flagged as awaiting verification', user.verificationRequired === false);
    check('no code was generated for it', (await prisma.emailVerificationToken.count({ where: { userId: user.id } })) === 0);
    check('and no "code sent" event was recorded', (await prisma.activityEvent.count({ where: { userId: user.id, type: 'EMAIL_VERIFICATION_SENT' } })) === 0);
    check('a registration and a session event were', (await prisma.activityEvent.count({ where: { userId: user.id, type: { in: ['USER_REGISTERED', 'SESSION_CREATED'] } } })) === 2);
    check('the new session works (heartbeat)', (await student.post('/api/session/heartbeat')).status === 200);
    check('the password was hashed, not stored', user.passwordHash !== 'Sturdy-Pass-77!x' && user.passwordHash.startsWith('$2'));

    const domains = ['outlook.com', 'mitwpu.edu.in', 'sub.example.co.in'];
    for (const [i, domain] of domains.entries()) {
      const r = await new Client().json('/api/auth/register', goodRegistration(`Other ${i}`, `${PREFIX}+other${i}@${domain}`));
      check(`${domain} registers too (no domain rule)`, r.status === 201, `status ${r.status}`);
    }
  }

  section('3. Registration still checks what it must');
  {
    const bad = async (label: string, payload: Record<string, unknown>) => {
      const r = await new Client().json('/api/auth/register', payload);
      check(label, r.status === 422, `status ${r.status}`);
    };
    await bad('an invalid email is refused (422)', goodRegistration('Bad Mail', 'not-an-email'));
    await bad('an empty email is refused (422)', goodRegistration('Bad Mail', ''));
    await bad('a weak password is refused (422)', { ...goodRegistration('Weak', `${PREFIX}+weak@gmail.com`), password: 'password1', confirmPassword: 'password1' });
    await bad('a password containing the email name is refused (422)', { ...goodRegistration('Same', `${PREFIX}+samename@gmail.com`), password: `${PREFIX}+samename-Aa1!`, confirmPassword: `${PREFIX}+samename-Aa1!` });
    await bad('mismatched passwords are refused (422)', { ...goodRegistration('Mismatch', `${PREFIX}+mismatch@gmail.com`), confirmPassword: 'Different-Pass-1!' });
    await bad('a missing name is refused (422)', { ...goodRegistration('', `${PREFIX}+noname@gmail.com`), name: '' });
    check('none of those created an account', (await prisma.user.count({ where: { email: { in: [`${PREFIX}+weak@gmail.com`, `${PREFIX}+samename@gmail.com`, `${PREFIX}+mismatch@gmail.com`, `${PREFIX}+noname@gmail.com`] } } })) === 0);
  }

  section('4. A duplicate email is a clear 409');
  {
    const existing = await make('dupe');
    const duplicate = await new Client().json('/api/auth/register', goodRegistration('Imposter', existing.email));
    const result = await body<{ error?: string }>(duplicate);
    check('registering an existing address is refused (409)', duplicate.status === 409, `status ${duplicate.status}`);
    check('and says to log in or recover the password', /log in/i.test(result.error ?? '') && /forgot password/i.test(result.error ?? ''), result.error);
    const shouting = await new Client().json('/api/auth/register', goodRegistration('Imposter', existing.email.toUpperCase()));
    check('a differently-cased copy is the same address (409)', shouting.status === 409, `status ${shouting.status}`);
    check('no second account exists', (await prisma.user.count({ where: { email: existing.email } })) === 1);
    const after = await row(existing.id);
    check('the existing account was not changed (password hash, name)', after.passwordHash === existing.passwordHash && after.name === existing.name);
    check('and they can still sign in with their own password', (await new Client().json('/api/auth/login', { email: existing.email, password: PASSWORD })).status === 200);
    const pending = await make('dupe-pending', { verificationRequired: true });
    check('an account that never verified is a duplicate too (409)', (await new Client().json('/api/auth/register', goodRegistration('Imposter', pending.email))).status === 409);
    await existingAccountsAreUntouched('off');
  }

  section('5. Registration is still rate-limited per network');
  {
    const crowd = new Client();
    const results: number[] = [];
    for (let i = 0; i < REGISTER_LIMIT + 2; i += 1) {
      results.push((await crowd.json('/api/auth/register', goodRegistration(`Rush ${i}`, `${PREFIX}+rush${i}@example.org`))).status);
    }
    check(`the first ${REGISTER_LIMIT} from one network succeed`, results.slice(0, REGISTER_LIMIT).every((status) => status === 201), results.join(','));
    check('then it is refused (429)', results.slice(REGISTER_LIMIT).every((status) => status === 429), results.join(','));
    check('and a different network is not affected', (await new Client().json('/api/auth/register', goodRegistration('Calm', `${PREFIX}+calm@example.org`))).status === 201);
  }

  section('6. Existing accounts that never verified can sign in — and are not marked verified');
  const pendingUser = await make('pending-login', { verificationRequired: true });
  const legacyUser = await make('legacy', {}, 'example.com');
  const proven = await make('proven', { emailVerifiedAt: new Date('2026-09-20T10:00:00Z') }, 'mitwpu.edu.in');
  {
    const pendingClient = await signIn(pendingUser);
    check('an account awaiting verification signs in with its password', pendingClient.hasSession());
    const legacyClient = await signIn(legacyUser);
    check('a legacy account signs in as before', legacyClient.hasSession());
    check('neither was marked verified by signing in', (await row(pendingUser.id)).emailVerifiedAt === null && (await row(legacyUser.id)).emailVerifiedAt === null);
    check('and the verification flag on the account was not rewritten', (await row(pendingUser.id)).verificationRequired === true);
    const wrong = await new Client().json('/api/auth/login', { email: pendingUser.email, password: 'Wrong-Password-1!' });
    check('a wrong password is still refused', wrong.status === 422, `status ${wrong.status}`);
    const proofBefore = (await row(proven.id)).emailVerifiedAt?.toISOString();
    await signIn(proven);
    check('an account that did verify keeps its verified time, untouched', (await row(proven.id)).emailVerifiedAt?.toISOString() === proofBefore);
  }

  section('7. Reading: no verification prompt, entitlements still decide');
  {
    const student = await signIn(pendingUser);
    const freePage = await seePage(await student.request(`/notes/${freeNote.id}`));
    check('an unverified student opens a FREE note page (no verification redirect)', freePage.status === 200 && freePage.to === null && !freePage.notFound, `status ${freePage.status} to ${freePage.to}`);
    const open = await student.post(`/api/notes/${freeNote.id}/view-token`);
    const opened = await body<{ token?: string; contentUrl?: string; viewId?: string; watermark?: unknown }>(open);
    check('and gets a view token (200)', open.status === 200 && Boolean(opened.token), `status ${open.status}`);
    const content = await student.request(opened.contentUrl!);
    const bytes = Buffer.from(await content.arrayBuffer());
    check('and the whole file, byte for byte', content.status === 200 && sha256(bytes) === sha(freeNote));

    const restrictedOpen = await student.post(`/api/notes/${restrictedNote.id}/view-token`);
    check('a RESTRICTED note is still closed to them without a grant (404, not a verification error)', restrictedOpen.status === 404, `status ${restrictedOpen.status}`);
    const restrictedPage = await seePage(await student.request(`/notes/${restrictedNote.id}`));
    check('its page does not render (not found)', restrictedPage.notFound && restrictedPage.to === null && !restrictedPage.html.includes(restrictedNote.title));
    await prisma.entitlement.create({ data: { userId: pendingUser.id, scope: 'NOTE', targetKey: `NOTE:${restrictedNote.id}`, noteId: restrictedNote.id, source: 'ADMIN_GRANT' } });
    const granted = await student.post(`/api/notes/${restrictedNote.id}/view-token`);
    const grantedBody = await body<{ contentUrl: string }>(granted);
    check('with an entitlement it opens', granted.status === 200);
    check('and reads all of it', sha256(Buffer.from(await (await student.request(grantedBody.contentUrl)).arrayBuffer())) === sha(restrictedNote));

    const legacyClient = await signIn(legacyUser);
    const pyqPage = await seePage(await legacyClient.request(`/pyqs/${pyq.id}`));
    check('a student with no grant does not get a paper either (not found)', pyqPage.notFound && pyqPage.to === null);
    const feedbackPage = await seePage(await student.request('/feedback'));
    check('the feedback page opens for an unverified student', feedbackPage.status === 200 && feedbackPage.to === null);
    const catalogue = await seePage(await student.request('/catalog'));
    check('the catalogue shows no "verify your email" banner', catalogue.status === 200 && !/verify your (college )?email/i.test(catalogue.html));
  }

  section('8. No watermark — and nothing else about access changed');
  {
    const student = await signIn(pendingUser);
    const open = await student.post(`/api/notes/${freeNote.id}/view-token`);
    const text = await open.text();
    const opened = JSON.parse(text) as { watermark?: unknown; viewId?: string };
    check('the view-token response carries no watermark (null)', opened.watermark === null);
    check("and not the reader's email, name or session reference anywhere in it", !text.includes(pendingUser.email) && !text.includes(pendingUser.name) && !/sessionRef/i.test(text));
    check('a per-reader view record is still kept', Boolean(opened.viewId) && (await prisma.noteView.count({ where: { userId: pendingUser.id, noteId: freeNote.id } })) >= 1);
    const grantedPaper = await prisma.entitlement.create({ data: { userId: legacyUser.id, scope: 'SUBJECT', targetKey: `SUBJECT:${subject.id}`, subjectId: subject.id, source: 'ADMIN_GRANT' } });
    const legacyClient = await signIn(legacyUser);
    const paper = await legacyClient.post(`/api/pyqs/${pyq.id}/view-token`);
    const paperText = await paper.text();
    check('a previous-year paper opens for a granted student', paper.status === 200);
    check('and carries no watermark either', (JSON.parse(paperText) as { watermark?: unknown }).watermark === null && !paperText.includes(legacyUser.email));
    await prisma.entitlement.delete({ where: { id: grantedPaper.id } });
    check('the storage key is never sent to the browser', !text.includes(freeNote.storageKey) && !paperText.includes(pyqKey));

    const visitor = new Client();
    check('an anonymous view-token request is still refused (401)', (await visitor.post(`/api/notes/${freeNote.id}/view-token`)).status === 401);
    check('an anonymous file request is still refused (401)', (await visitor.request(`/api/notes/${freeNote.id}/content`)).status === 401);
    const token = (JSON.parse(text) as { token: string }).token;
    check('a stolen link is useless without the session (401)', (await visitor.request(`/api/notes/${freeNote.id}/content?t=${encodeURIComponent(token)}`)).status === 401);
    const other = await signIn(await make('other-reader'));
    check("another student cannot use someone else's token (403)", (await other.request(`/api/notes/${freeNote.id}/content?t=${encodeURIComponent(token)}`)).status === 403);
    check('a forged token is refused (403)', (await student.request(`/api/notes/${freeNote.id}/content?t=forged.token`)).status === 403);
    check('the file without a token is refused (403)', (await student.request(`/api/notes/${freeNote.id}/content`)).status === 403);
  }

  section('9. The verification pages and APIs are gone while it is off');
  {
    const snapshot = async (id: string) => JSON.stringify(await row(id));
    const student = await signIn(pendingUser);
    const beforeRow = await snapshot(pendingUser.id);
    const tokensBefore = await prisma.emailVerificationToken.count();
    const eventsBefore = await prisma.activityEvent.count({ where: { type: { in: ['EMAIL_VERIFICATION_SENT', 'EMAIL_VERIFIED', 'EMAIL_VERIFICATION_FAILED'] } } });

    const anonymous = new Client();
    const probes: [string, string, unknown?][] = [
      ['POST', '/api/auth/verify-email', { email: pendingUser.email, code: '123456' }],
      ['PUT', '/api/auth/verify-email', { email: pendingUser.email }],
      ['POST', '/api/auth/verify-current-email'],
      ['PUT', '/api/auth/verify-current-email', { code: '123456' }],
      ['POST', '/api/auth/college-email', { email: `${PREFIX}+x@mitwpu.edu.in` }],
      ['PUT', '/api/auth/college-email', { code: '123456' }],
    ];
    for (const [method, route, payload] of probes) {
      const asVisitor = await anonymous.request(route, { method, headers: { 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
      const asStudent = await student.request(route, { method, headers: { 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
      check(`${method} ${route} → 404 for a visitor and for a student`, asVisitor.status === 404 && asStudent.status === 404, `${asVisitor.status}/${asStudent.status}`);
    }
    check('no code was created and no verification event recorded', (await prisma.emailVerificationToken.count()) === tokensBefore && (await prisma.activityEvent.count({ where: { type: { in: ['EMAIL_VERIFICATION_SENT', 'EMAIL_VERIFIED', 'EMAIL_VERIFICATION_FAILED'] } } })) === eventsBefore);
    check('the account was not modified (no pending address, still unverified)', (await snapshot(pendingUser.id)) === beforeRow && (await row(pendingUser.id)).pendingEmail === null);

    const verifyPage = await seePage(await anonymous.request(`/verify-email?email=${encodeURIComponent(pendingUser.email)}`));
    check('/verify-email redirects to sign-in', goes(verifyPage, '/login'), `status ${verifyPage.status} to ${verifyPage.to}`);
    const collegePage = await seePage(await student.request('/verify-college-email'));
    check('/verify-college-email redirects a signed-in student to the catalogue', collegePage.to === '/', `status ${collegePage.status} to ${collegePage.to}`);
    const collegeVisitor = await seePage(await anonymous.request('/verify-college-email'));
    check('and a visitor too (to a page that exists)', collegeVisitor.to !== null && !collegeVisitor.notFound, `to ${collegeVisitor.to}`);
    const register = await seePage(await anonymous.request('/register'));
    check('the registration page itself is a form, with no college-email wording', register.status === 200 && !/mitwpu/i.test(register.html) && !/6-digit/i.test(register.html));
    check('and offers a plain email field', /you@example\.com/.test(register.html));
  }

  section('10. Password recovery, sessions and admin are untouched');
  {
    const subjectUser = await make('recover');
    const forgot = await new Client().json('/api/auth/forgot-password', { email: subjectUser.email });
    check('"forgot password" still answers (200)', forgot.status === 200, `status ${forgot.status}`);
    const resetRows = await prisma.passwordResetToken.findMany({ where: { userId: subjectUser.id } });
    check('and creates a reset link for the account', resetRows.length === 1 && resetRows[0].usedAt === null);
    const unknown = await new Client().json('/api/auth/forgot-password', { email: `${PREFIX}+nobody@gmail.com` });
    check('and answers identically for an address with no account', unknown.status === 200 && JSON.stringify(await body(unknown)) === JSON.stringify(await body(forgot)));

    const token = randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.create({ data: { userId: subjectUser.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 600_000) } });
    const newPassword = 'Brand-New-Pass-88!z';
    const reset = await new Client().json('/api/auth/reset-password', { token, password: newPassword, confirmPassword: newPassword });
    check('a valid reset link sets a new password (200)', reset.status === 200, `status ${reset.status}`);
    check('the new password signs in and the old one no longer does', (await new Client().json('/api/auth/login', { email: subjectUser.email, password: newPassword })).status === 200 && (await new Client().json('/api/auth/login', { email: subjectUser.email, password: PASSWORD })).status === 422);
    check('the link cannot be used twice', (await new Client().json('/api/auth/reset-password', { token, password: newPassword, confirmPassword: newPassword })).status === 422);
    check('recovering a password did not mark the address verified', (await row(subjectUser.id)).emailVerifiedAt === null);

    // --- the reset link is single-use even under simultaneous requests ---------
    const racer = await make('reset-race');
    const raceSession = await signIn(racer);
    const raceToken = randomBytes(32).toString('base64url');
    const raceHash = createHash('sha256').update(raceToken).digest('hex');
    await prisma.passwordResetToken.create({ data: { userId: racer.id, tokenHash: raceHash, expiresAt: new Date(Date.now() + 600_000) } });
    const attempts = Array.from({ length: 8 }, (_, i) => `Race-Pass-${i}-Aa1!x`);
    const answers = await Promise.all(
      attempts.map((password) => new Client().json('/api/auth/reset-password', { token: raceToken, password, confirmPassword: password })),
    );
    const statuses = answers.map((r) => r.status);
    check('of 8 simultaneous uses of one reset link exactly one succeeds (200), the rest are refused (422)', statuses.filter((v) => v === 200).length === 1 && statuses.filter((v) => v === 422).length === 7, statuses.join(','));
    const winner = statuses.indexOf(200);
    const loginWith = async (password: string) => (await new Client().json('/api/auth/login', { email: racer.email, password })).status;
    // (Sign-in attempts per account are themselves limited, so a handful of the losers are tried.)
    check('the original password no longer works', (await loginWith(PASSWORD)) === 422);
    check("and the winner's password signs in", (await loginWith(attempts[winner])) === 200);
    const losers = attempts.filter((_, i) => i !== winner).slice(0, 5);
    let losersSignIn = 0;
    for (const password of losers) if ((await loginWith(password)) === 200) losersSignIn += 1;
    check("and none of the losers' passwords do — the account was not changed twice", losersSignIn === 0);
    const spent = await prisma.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: raceHash } });
    check('the link is recorded as used', spent.usedAt !== null);
    check('the existing session was ended, once', (await raceSession.post('/api/session/heartbeat')).status === 401);
    check('and exactly one completed reset was recorded', (await prisma.activityEvent.count({ where: { userId: racer.id, type: 'PASSWORD_RESET_COMPLETED' } })) === 1);
    check('a used link stays dead afterwards', (await new Client().json('/api/auth/reset-password', { token: raceToken, password: 'Another-Pass-5!zz', confirmPassword: 'Another-Pass-5!zz' })).status === 422);

    // --- expiry, and a rejected password does not burn the link ----------------
    const careful = await make('reset-expiry');
    const expiredToken = randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.create({ data: { userId: careful.id, tokenHash: createHash('sha256').update(expiredToken).digest('hex'), expiresAt: new Date(Date.now() - 1000) } });
    const expiredTry = await new Client().json('/api/auth/reset-password', { token: expiredToken, password: 'Expired-Pass-1!zz', confirmPassword: 'Expired-Pass-1!zz' });
    check('an expired link is refused (422)', expiredTry.status === 422, `status ${expiredTry.status}`);
    check('and the password was not changed', (await new Client().json('/api/auth/login', { email: careful.email, password: PASSWORD })).status === 200);
    const liveToken = randomBytes(32).toString('base64url');
    const liveHash = createHash('sha256').update(liveToken).digest('hex');
    await prisma.passwordResetToken.create({ data: { userId: careful.id, tokenHash: liveHash, expiresAt: new Date(Date.now() + 600_000) } });
    const weak = await new Client().json('/api/auth/reset-password', { token: liveToken, password: 'password1', confirmPassword: 'password1' });
    check('a weak new password is refused (422)', weak.status === 422, `status ${weak.status}`);
    check('and does not use up the link', (await prisma.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: liveHash } })).usedAt === null);
    const strong = await new Client().json('/api/auth/reset-password', { token: liveToken, password: 'Fresh-Strong-Pass-3!', confirmPassword: 'Fresh-Strong-Pass-3!' });
    check('the same link then works with a strong one (200)', strong.status === 200, `status ${strong.status}`);

    const lockUser = await make('session-lock');
    const first = new Client();
    check('first sign-in works', (await first.json('/api/auth/login', { email: lockUser.email, password: PASSWORD })).status === 200);
    const second = new Client();
    const conflict = await second.json('/api/auth/login', { email: lockUser.email, password: PASSWORD });
    check('a second device is refused while the first is live (409, session_conflict)', conflict.status === 409 && (await body<{ code?: string }>(conflict)).code === 'session_conflict', `status ${conflict.status}`);
    check('and may take over deliberately', (await second.json('/api/auth/login', { email: lockUser.email, password: PASSWORD, force: true })).status === 200);
    check('which ends the first session', (await first.post('/api/session/heartbeat')).status === 401);

    const lockout = await make('lockout');
    let last = 0;
    for (let i = 0; i < 9; i += 1) last = (await new Client().json('/api/auth/login', { email: lockout.email, password: 'Wrong-Password-1!' })).status;
    check('repeated wrong passwords still lock the account (429)', last === 429, `status ${last}`);
    check('even for the right password while locked', (await new Client().json('/api/auth/login', { email: lockout.email, password: PASSWORD })).status === 429);

    const admin = await make('admin', { role: 'ADMIN' });
    const visitor = new Client();
    const adminPage = await seePage(await visitor.request('/admin'));
    check('/admin still sends a visitor to sign-in', goes(adminPage, '/login'), `status ${adminPage.status}`);
    check('admin APIs still refuse a visitor (401)', (await visitor.post('/api/admin/notes')).status === 401 && (await visitor.post('/api/admin/uploads/presign')).status === 401);
    const student = await signIn(pendingUser);
    check('and a student (404)', (await student.post('/api/admin/notes')).status === 404 && (await student.post('/api/admin/uploads/presign')).status === 404);
    const bounced = await seePage(await student.request('/admin'));
    check('a student is bounced from /admin', bounced.to !== null && !bounced.to.startsWith('/admin'));
    const adminClient = await signIn(admin);
    const overview = await adminClient.request('/admin');
    const overviewHtml = await overview.text();
    check('an admin signs in and reaches /admin', overview.status === 200);
    check('the overview has no "Verified students" card while verification is off', !/Verified students/.test(overviewHtml) && /Total students/.test(overviewHtml));
    const usersPage = await (await adminClient.request('/admin/users')).text();
    check('and the users page has no verification card or "needs email" badge', !/Legacy email verification/.test(usersPage) && !/needs email/.test(usersPage));
  }

  // =========================================================================
  // Server DEFAULT: nothing set. This is what the deployment gets by default.
  // =========================================================================
  section('11. The setting unset behaves as off');
  {
    const server = await startServer({ OPEN_ACCESS_MODE: 'false' });
    BASE_URL = server.baseUrl;
    const r = await new Client().json('/api/auth/register', goodRegistration('Default', `${PREFIX}+default@gmail.com`));
    check('with EMAIL_VERIFICATION_REQUIRED unset, any email registers and is signed in (201)', r.status === 201, `status ${r.status}`);
    check('and the verification API does not exist (404)', (await new Client().post('/api/auth/verify-current-email')).status === 404);
  }

  // =========================================================================
  // Server ON: the previous behaviour, restored by the setting alone.
  // =========================================================================
  section('12. Switched back on: the previous behaviour, restored');
  {
    const ON = await startServer({ EMAIL_VERIFICATION_REQUIRED: 'true', NOTE_WATERMARK_ENABLED: 'true', OPEN_ACCESS_MODE: 'false' });
    await placeFiles(ON);
    BASE_URL = ON.baseUrl;

    const gmail = await new Client().json('/api/auth/register', goodRegistration('Gmail', `${PREFIX}+on-gmail@gmail.com`));
    check('a non-college address is refused again (422)', gmail.status === 422, `status ${gmail.status}`);
    check('and no account was created', (await prisma.user.count({ where: { email: `${PREFIX}+on-gmail@gmail.com` } })) === 0);

    const client = new Client();
    const college = `${PREFIX}+on-college@mitwpu.edu.in`;
    const registered = await client.json('/api/auth/register', goodRegistration('College', college));
    const result = await body<{ status?: string }>(registered);
    check('a college address is accepted with a code on its way (202, verification_sent)', registered.status === 202 && result.status === 'verification_sent', `status ${registered.status}`);
    check('and nobody is signed in', !client.hasSession());
    const created = await prisma.user.findUniqueOrThrow({ where: { email: college } });
    check('the account awaits verification, with a code issued', created.verificationRequired === true && created.emailVerifiedAt === null && (await prisma.emailVerificationToken.count({ where: { userId: created.id, consumedAt: null } })) === 1);
    const login = await new Client().json('/api/auth/login', { email: college, password: 'Sturdy-Pass-77!x' });
    check('it cannot sign in until verified (403, email_unverified)', login.status === 403 && (await body<{ code?: string }>(login)).code === 'email_unverified', `status ${login.status}`);
    const dup = await new Client().json('/api/auth/register', goodRegistration('Dup', college));
    check('a duplicate is refused with the clear 409 here too', dup.status === 409, `status ${dup.status}`);
    await existingAccountsAreUntouched('on');

    check('the verification API is alive again (401 for a visitor, not 404)', (await new Client().post('/api/auth/verify-current-email')).status === 401 && (await new Client().post('/api/auth/college-email')).status === 401);
    const verifyPage = await seePage(await new Client().request(`/verify-email?email=${encodeURIComponent(college)}`));
    check('and the verify page is back', verifyPage.status === 200 && verifyPage.to === null && !verifyPage.notFound);

    const unverified = await signIn(await make('on-unverified', {}, 'mitwpu.edu.in'));
    const gated = await unverified.post(`/api/notes/${freeNote.id}/view-token`);
    check('an unverified student is gated from reading again (403, email_migration_required)', gated.status === 403 && (await body<{ code?: string }>(gated)).code === 'email_migration_required', `status ${gated.status}`);
    const gatedPage = await seePage(await unverified.request(`/notes/${freeNote.id}`));
    check('and sent to verify from the note page', goes(gatedPage, '/verify-college-email'), `to ${gatedPage.to}`);

    const onAdmin = await signIn(await make('on-admin', { role: 'ADMIN' }, 'mitwpu.edu.in'));
    const onOverview = await (await onAdmin.request('/admin')).text();
    check('the admin overview shows "Verified students" again', /Verified students/.test(onOverview));
    check('and the users page its verification card', /Legacy email verification/.test(await (await onAdmin.request('/admin/users')).text()));

    // The reset link is single-use under simultaneous requests here too.
    const onRacer = await make('on-reset-race', {}, 'mitwpu.edu.in');
    const onToken = randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.create({ data: { userId: onRacer.id, tokenHash: createHash('sha256').update(onToken).digest('hex'), expiresAt: new Date(Date.now() + 600_000) } });
    const onAnswers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => new Client().json('/api/auth/reset-password', { token: onToken, password: `On-Race-Pass-${i}-Aa1!`, confirmPassword: `On-Race-Pass-${i}-Aa1!` })),
    );
    check('with verification on, of 6 simultaneous uses of a reset link exactly one succeeds', onAnswers.filter((r) => r.status === 200).length === 1 && onAnswers.filter((r) => r.status === 422).length === 5, onAnswers.map((r) => r.status).join(','));

    const verified = await make('on-verified', { emailVerifiedAt: new Date() }, 'mitwpu.edu.in');
    const verifiedClient = await signIn(verified);
    const open = await verifiedClient.post(`/api/notes/${freeNote.id}/view-token`);
    const opened = await body<{ watermark?: { email?: string; sessionRef?: string } | null; contentUrl?: string }>(open);
    check('a verified student reads, and the watermark is back with NOTE_WATERMARK_ENABLED=true', open.status === 200 && opened.watermark?.email === verified.email && Boolean(opened.watermark?.sessionRef));
    check('and the file still arrives whole', sha256(Buffer.from(await (await verifiedClient.request(opened.contentUrl!)).arrayBuffer())) === sha(freeNote));
  }

  // =========================================================================
  // Server INVALID: a value that is not recognised must not switch checks off.
  // =========================================================================
  section('13. An unrecognised value keeps verification on');
  {
    for (const value of ['yes', 'maybe']) {
      const server = await startServer({ EMAIL_VERIFICATION_REQUIRED: value, OPEN_ACCESS_MODE: 'false' });
      BASE_URL = server.baseUrl;
      const r = await new Client().json('/api/auth/register', goodRegistration('Typo', `${PREFIX}+typo-${value}@gmail.com`));
      check(`EMAIL_VERIFICATION_REQUIRED=${value}: a non-college address is still refused (422)`, r.status === 422, `status ${r.status}`);
      check(`EMAIL_VERIFICATION_REQUIRED=${value}: the verification API is still alive (401, not 404)`, (await new Client().post('/api/auth/verify-current-email')).status === 401);
    }
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
    await Promise.all(ownedServers.map((server) => server.stop()));
    await prisma.$disconnect();
  });
