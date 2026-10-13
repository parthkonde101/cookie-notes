/**
 * Verifies the footer on every page of a note or previous-year paper: its
 * opaque account reference, where it is drawn, that nothing identifying reaches
 * the browser for it, and that it can be switched off.
 *
 *   npm run build
 *   DATABASE_URL=<local test db> VERIFY_DISPOSABLE_DB=<its name> AUTH_SECRET=<16+ chars> \
 *     npm run verify:watermark
 *
 * The suite starts its OWN production servers (`next start` on free loopback
 * ports) against exactly the database it has approved — footer on (the default),
 * switched off, and set to an unrecognised value — and proves each is using that
 * database before any test runs. VERIFY_BASE_URL must not be set.
 *
 * It creates and deletes accounts, notes and papers, so it REFUSES TO RUN unless
 * the database is a disposable local one you have named in VERIFY_DISPOSABLE_DB
 * (scripts/lib/disposable-db.ts). Fixtures are prefixed `wmtest+` / `[wmtest]`.
 *
 * What it cannot check is how the footer LOOKS on a page — that is a browser
 * concern, covered by looking at real pages at several sizes. It does check the
 * drawing code's geometry (the footer sits entirely below the page) with a
 * recording canvas.
 */
import 'dotenv/config';
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

const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {} } as NodeJS.Module;

import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { makeTestPdf } from './make-test-pdf';

const PREFIX = 'wmtest';
const PASSWORD = 'Water-Mark-2026!';
const IP_PREFIX = '203.0.113.';
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

let BASE_URL = '';
let ipCounter = 10;
class Client {
  private cookies = new Map<string, string>();
  readonly ip = `${IP_PREFIX}${ipCounter++}`;
  async request(path_: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set('cookie', [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
    headers.set('user-agent', 'CookieNotes-Verify/watermark');
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
  json(path_: string, payload: unknown) {
    return this.request(path_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }
  post(path_: string) {
    return this.request(path_, { method: 'POST' });
  }
}

async function cleanup() {
  await prisma.user.deleteMany({ where: { email: { contains: `${PREFIX}+` } } });
  await prisma.subject.deleteMany({ where: { name: { startsWith: '[wmtest]' } } });
  await prisma.semester.deleteMany({ where: { name: { startsWith: '[wmtest]' } } });
  await prisma.rateLimit.deleteMany({ where: { OR: [{ key: { contains: IP_PREFIX } }, { key: { contains: `${PREFIX}+` } }] } });
}
const handshakeProbe = {
  countMarker: (marker: string) =>
    prisma.activityEvent.count({ where: { type: 'LOGIN_FAILED', metadata: { path: ['email'], equals: marker } } }),
};
const servers: OwnedServer[] = [];

/** A canvas that records what is drawn instead of drawing it. */
function recordingContext() {
  const calls: { kind: 'text' | 'rect'; text?: string; x: number; y: number; w?: number; h?: number; align: string }[] = [];
  const state = { font: '', fillStyle: '', textAlign: 'left', textBaseline: 'alphabetic' };
  const ctx = {
    save() {}, restore() {},
    get font() { return state.font; }, set font(v: string) { state.font = v; },
    get fillStyle() { return state.fillStyle; }, set fillStyle(v: string) { state.fillStyle = v; },
    get textAlign() { return state.textAlign; }, set textAlign(v: string) { state.textAlign = v; },
    get textBaseline() { return state.textBaseline; }, set textBaseline(v: string) { state.textBaseline = v; },
    fillText(text: string, x: number, y: number) { calls.push({ kind: 'text', text, x, y, align: state.textAlign }); },
    fillRect(x: number, y: number, w: number, h: number) { calls.push({ kind: 'rect', x, y, w, h, align: state.textAlign }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, state };
}

async function main() {
  console.log(`\nVerifying the page footer\n${'─'.repeat(56)}`);
  const [identity] = await prisma.$queryRaw<{ db: string; addr: string | null; foreign_users: bigint }[]>`
    SELECT current_database() AS db, host(inet_server_addr()) AS addr,
           (SELECT count(*) FROM users WHERE email NOT LIKE ${`${PREFIX}+%`}) AS foreign_users`;
  const problems = evaluateDatabaseIdentity(
    { database: identity.db, serverAddress: identity.addr, foreignUsers: Number(identity.foreign_users) },
    targetVerdict.database!,
  );
  if (problems.length > 0) {
    console.error('\nREFUSING TO RUN — the connected database failed its identity check:');
    for (const reason of problems) console.error(`  • ${reason}`);
    console.error('\nNothing was changed.\n');
    process.exitCode = 3;
    return;
  }
  await cleanup();

  const { accountReference, userIdsForReference, REFERENCE_PATTERN } = await import('../src/lib/access/account-reference');
  const { drawFooter, footerHeight, FOOTER_FRACTION } = await import('../src/components/notes/watermark');
  const { readWatermarkSetting } = await import('../src/lib/env');

  // --- fixtures ---------------------------------------------------------------
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const make = (name: string, role: 'STUDENT' | 'ADMIN' = 'STUDENT') =>
    prisma.user.create({ data: { email: `${PREFIX}+${name}@example.com`, name: `Mark ${name}`, passwordHash, role, status: 'ACTIVE' } });
  const alice = await make('alice');
  const bob = await make('bob');
  const admin = await make('admin', 'ADMIN');

  const stamp = Date.now();
  const semester = await prisma.semester.create({ data: { name: '[wmtest] Sem', slug: `wmtest-${stamp}`, position: 93 } });
  const subject = await prisma.subject.create({ data: { semesterId: semester.id, name: '[wmtest] Subject', slug: `wmtest-sub-${stamp}` } });
  const noteKey = `notes/2026/10/wmtest-${stamp}.pdf`;
  const pyqKey = `pyqs/2026/wmtest-${stamp}.pdf`;
  const pdf = makeTestPdf('footer test');
  const note = await prisma.note.create({ data: { title: '[wmtest] note', subjectId: subject.id, storageKey: noteKey, fileName: 'n.pdf', fileSize: pdf.length, status: 'PUBLISHED', visibility: 'FREE' } });
  const note2 = await prisma.note.create({ data: { title: '[wmtest] note two', subjectId: subject.id, storageKey: `${noteKey}.2`, fileName: 'n2.pdf', fileSize: pdf.length, status: 'PUBLISHED', visibility: 'FREE' } });
  const pyq = await prisma.pyq.create({ data: { subjectId: subject.id, year: 2025, storageKey: pyqKey, fileName: 'p.pdf', fileSize: pdf.length } });
  await prisma.entitlement.create({ data: { userId: alice.id, scope: 'SUBJECT', targetKey: `SUBJECT:${subject.id}`, subjectId: subject.id, source: 'ADMIN_GRANT' } });
  await prisma.entitlement.create({ data: { userId: bob.id, scope: 'SUBJECT', targetKey: `SUBJECT:${subject.id}`, subjectId: subject.id, source: 'ADMIN_GRANT' } });

  async function start(extraEnv: Record<string, string>): Promise<OwnedServer> {
    const server = await startOwnedServer({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? '', extraEnv });
    servers.push(server);
    if (!(await confirmServerUsesDatabase(server.baseUrl, handshakeProbe))) throw new Error('A test server could not be shown to be using the approved database.');
    for (const key of [noteKey, `${noteKey}.2`, pyqKey]) {
      const target = path.join(server.storageDir, key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, pdf);
    }
    return server;
  }
  const signIn = async (user: { email: string }) => {
    const client = new Client();
    const response = await client.json('/api/auth/login', { email: user.email, password: PASSWORD, force: true });
    if (response.status !== 200) throw new Error(`could not sign ${user.email} in: ${response.status}`);
    return client;
  };
  type Open = { watermark?: { reference?: string; issuedAt?: string } | null; viewId?: string | null; contentUrl?: string };
  const openOf = async (client: Client, kind: 'notes' | 'pyqs', id: string) => {
    const response = await client.post(`/api/${kind}/${id}/view-token`);
    const text = await response.text();
    return { status: response.status, text, body: (JSON.parse(text || '{}') as Open) };
  };

  // =========================================================================
  section('1. The account reference');
  {
    const ref = accountReference(alice.id);
    check('it has the form CN- plus eight characters', REFERENCE_PATTERN.test(ref), ref);
    check('it is stable: the same account always gets the same reference', accountReference(alice.id) === ref && accountReference(alice.id) === ref);
    check('and different accounts get different ones', accountReference(bob.id) !== ref && accountReference(admin.id) !== ref);
    check('it contains no part of the id, the email or the name', !ref.toLowerCase().includes(alice.id.slice(-6).toLowerCase()) && !alice.id.toLowerCase().includes(ref.slice(3).toLowerCase()) && !/alice|wmtest/i.test(ref));
    const refs = new Set(Array.from({ length: 2000 }, (_, i) => accountReference(`user-${i}`)));
    check('2,000 different ids give 2,000 different references (no collisions at this scale)', refs.size === 2000, String(refs.size));
    check('it uses only unambiguous characters (no I, L, O or U)', [...refs].every((value) => /^CN-[0-9A-HJKMNP-TV-Z]{8}$/.test(value)));
    const keep = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'a-completely-different-secret-value-0123456789';
    const rotated = accountReference(alice.id);
    process.env.AUTH_SECRET = keep;
    check('it is keyed by the server secret — another secret gives another reference (so it cannot be guessed from an id)', rotated !== ref);
    check('and returns to the same value with the same secret', accountReference(alice.id) === ref);
    check('an admin can look an account up from its reference', JSON.stringify(await userIdsForReference(ref)) === JSON.stringify([alice.id]));
    check('lowercase and spaces are forgiven; anything that is not a reference finds nothing', (await userIdsForReference(` ${ref.toLowerCase()} `)).length === 1 && (await userIdsForReference('alice')).length === 0 && (await userIdsForReference('CN-')).length === 0 && (await userIdsForReference('')).length === 0);
  }

  section('2. The footer setting');
  {
    check('on when unset, empty, "true", "1" or anything unrecognised', [undefined, '', 'true', '1', 'yes', 'flase', 'off'].every((v) => readWatermarkSetting(v)));
    check('off only for "false" or "0", ignoring case and spaces', ['false', 'FALSE', ' 0 ', ' False '].every((v) => !readWatermarkSetting(v)));
  }

  section('3. Where it is drawn — entirely below the page');
  {
    for (const [label, width, height] of [['A4 portrait', 1240, 1754], ['A4 landscape', 1754, 1240], ['a phone-width page', 360, 509], ['a tall narrow page', 600, 1800], ['a wide short slide', 1800, 600], ['a very small page', 120, 160]] as const) {
      const { ctx, calls } = recordingContext();
      drawFooter(ctx, width, height, { reference: 'CN-7K2M9QXA' }, 12);
      const strip = footerHeight(width);
      const texts = calls.filter((call) => call.kind === 'text');
      check(`${label}: two pieces of text, the site on the left and the reference and page on the right`, texts.length === 2 && texts[0].text === 'cookienotes.app' && texts[0].align === 'left' && texts[1].text === 'CN-7K2M9QXA · Page 12' && texts[1].align === 'right', JSON.stringify(texts.map((t) => t.text)));
      check(`${label}: everything is drawn in the strip below the page, none of it over the page`, calls.every((call) => call.y >= height && call.y <= height + strip), JSON.stringify(calls.map((call) => call.y)) + ` (page ${height}, strip ${strip})`);
      check(`${label}: the text stays inside the page's width`, texts.every((text) => text.x >= 0 && text.x <= width));
    }
    check('the strip is a fixed proportion of the page width, so it scales with zoom and screen', footerHeight(2000) === Math.round(2000 * FOOTER_FRACTION) && footerHeight(1000) * 2 - footerHeight(2000) <= 1);
    check('and never collapses to nothing', footerHeight(10) >= 20);
    check('on a phone the strip keeps a readable minimum in CSS pixels (20 at 1x, 40 at 2x)', footerHeight(300, 1) === 20 && footerHeight(660, 2) === 40 && footerHeight(1680, 2) === 54);
    const phone = recordingContext();
    drawFooter(phone.ctx, 660, 900, { reference: 'CN-7K2M9QXA' }, 2, 2);
    check('and its text is at least 8 CSS pixels (16 canvas pixels at 2x)', Number.parseInt(phone.state.font, 10) >= 16, phone.state.font);
    const empty = recordingContext();
    drawFooter(empty.ctx, 800, 1100, { reference: '   ' }, 1);
    check('no reference means nothing is drawn', empty.calls.length === 0);
    const { calls } = recordingContext();
    const rec = recordingContext();
    drawFooter(rec.ctx, 800, 1100, { reference: 'CN-7K2M9QXA' }, 3);
    check('the text is small and grey (a quiet footer)', /^\d+px /.test(rec.state.font) && Number.parseInt(rec.state.font, 10) <= Math.round(footerHeight(800) * 0.5) && rec.state.fillStyle === '#8a8a8a', `${rec.state.font} ${rec.state.fillStyle}`);
    check('and never an email address', ![...calls, ...rec.calls].some((call) => (call.text ?? '').includes('@')));
  }

  // =========================================================================
  const ON = await start({ OPEN_ACCESS_MODE: 'false' });
  BASE_URL = ON.baseUrl;
  const aliceClient = await signIn(alice);
  const bobClient = await signIn(bob);

  section('4. Notes and papers send the same footer — derived on the server');
  {
    const n1 = await openOf(aliceClient, 'notes', note.id);
    const n2 = await openOf(aliceClient, 'notes', note2.id);
    const p1 = await openOf(aliceClient, 'pyqs', pyq.id);
    const mine = accountReference(alice.id);
    check('a note carries this account\'s reference', n1.status === 200 && n1.body.watermark?.reference === mine, JSON.stringify(n1.body.watermark));
    check('another note carries the very same reference', n2.body.watermark?.reference === mine);
    check('and so does a previous-year paper — notes and papers are treated alike', p1.status === 200 && p1.body.watermark?.reference === mine, JSON.stringify(p1.body.watermark));
    check('reopening gives the same reference again (stable)', (await openOf(aliceClient, 'notes', note.id)).body.watermark?.reference === mine);
    const b1 = await openOf(bobClient, 'notes', note.id);
    check('another student gets their own', b1.body.watermark?.reference === accountReference(bob.id) && b1.body.watermark?.reference !== mine);
    for (const [label, opened, user] of [['note', n1, alice], ['paper', p1, alice]] as const) {
      check(`the ${label} response holds only the reference and a time — no email, name, id, session or storage key`, Object.keys(opened.body.watermark ?? {}).sort().join() === 'issuedAt,reference' && ![user.email, user.name, user.id, noteKey, pyqKey, 'sessionRef'].some((secret) => opened.text.includes(secret)), opened.text);
    }
    check('no field of any response lets the browser name the reference (it takes no input)', n1.text.indexOf('reference') === n1.text.lastIndexOf('reference'));

    const forged = await aliceClient.request(`/api/notes/${note.id}/view-token?reference=${accountReference(bob.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: accountReference(bob.id), userId: bob.id }) });
    check('a reference or user id supplied by the browser is ignored — it is still the signed-in account\'s own', (JSON.parse(await forged.text()) as Open).watermark?.reference === mine);
    check('an anonymous request gets no footer and no token (401)', (await new Client().post(`/api/notes/${note.id}/view-token`)).status === 401 && (await new Client().post(`/api/pyqs/${pyq.id}/view-token`)).status === 401);
    const stolen = await bobClient.request(n1.body.contentUrl!);
    check('a token minted for another account is still refused (403) — the footer changed nothing about access', stolen.status === 403, `status ${stolen.status}`);
    const own = await aliceClient.request(n1.body.contentUrl!);
    check('the signed-in account still reads the file as before (200, no-store)', own.status === 200 && (own.headers.get('cache-control') ?? '').includes('no-store'));
    check('the file is not altered by the footer (server-side stamping is not part of this phase)', Buffer.from(await own.arrayBuffer()).equals(pdf));
    const noToken = await aliceClient.request(`/api/notes/${note.id}/content`);
    check('the file without a token is still refused (403)', noToken.status === 403);
  }

  section('5. An admin finds the account from a reference');
  {
    const adminClient = await signIn(admin);
    const search = async (q: string) => (await (await adminClient.request(`/admin/users?q=${encodeURIComponent(q)}`)).text());
    const html = await search(accountReference(alice.id));
    check('pasting a footer reference into the users search shows that account', html.includes(alice.email) && !html.includes(bob.email));
    check('another reference shows its own account', (await search(accountReference(bob.id))).includes(bob.email));
    check('the search box says it accepts one', /CN- reference/.test(html));
    const none = await search('CN-00000000');
    check('an unknown reference shows no student', !none.includes(`${PREFIX}+alice`) && !none.includes(`${PREFIX}+bob`));
    check('a student cannot use the admin search (redirected away)', (await (await aliceClient.request('/admin/users?q=x')).text()).includes('wmtest+alice@example.com') === false);
  }

  // =========================================================================
  section('6. Switched off, and a typo');
  {
    const OFF = await start({ OPEN_ACCESS_MODE: 'false', NOTE_WATERMARK_ENABLED: 'false' });
    BASE_URL = OFF.baseUrl;
    const client = await signIn(alice);
    const note_ = await openOf(client, 'notes', note.id);
    const paper = await openOf(client, 'pyqs', pyq.id);
    check('NOTE_WATERMARK_ENABLED=false: a note carries no footer at all (null)', note_.status === 200 && note_.body.watermark === null);
    check('and neither does a paper', paper.status === 200 && paper.body.watermark === null);
    check('and no reference is sent anywhere in the response', !note_.text.includes('CN-') && !paper.text.includes('CN-'));
    check('access is exactly as before: the file is served whole', (await client.request(note_.body.contentUrl!)).status === 200 && (await new Client().post(`/api/notes/${note.id}/view-token`)).status === 401);

    const TYPO = await start({ OPEN_ACCESS_MODE: 'false', NOTE_WATERMARK_ENABLED: 'flase' });
    BASE_URL = TYPO.baseUrl;
    const typoOpen = await openOf(await signIn(alice), 'notes', note.id);
    check('a typo (flase) keeps the footer ON — a mistake cannot quietly remove attribution', typoOpen.body.watermark?.reference === accountReference(alice.id));

    const ZERO = await start({ OPEN_ACCESS_MODE: 'false', NOTE_WATERMARK_ENABLED: '0' });
    BASE_URL = ZERO.baseUrl;
    check('"0" switches it off', (await openOf(await signIn(alice), 'notes', note.id)).body.watermark === null);
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
    await Promise.all(servers.map((server) => server.stop()));
    await prisma.$disconnect();
  });
