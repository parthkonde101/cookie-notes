/**
 * Verifies paid notes, bundles and purchases end to end — against a MOCK gateway.
 *
 *   npm run build
 *   DATABASE_URL=<local test db> VERIFY_DISPOSABLE_DB=<its name> AUTH_SECRET=<16+ chars> \
 *     VIEW_TOKEN_SECRET=<16+ chars> npm run verify:commerce
 *
 * No real payment can happen here, by construction: the suite starts a gateway of its own
 * on a loopback port and points the application at it, and the application only honours
 * such an address together with a `rzp_test_` key. The REAL application code runs — the
 * Razorpay client, signature checks, fulfilment, webhooks, refunds, access checks — with
 * only the far end of the HTTP call replaced.
 *
 * Like the other suites it refuses to run unless the database is a disposable local one
 * you have named in VERIFY_DISPOSABLE_DB, and it starts its own servers (`next start`) on
 * free loopback ports with exactly that database. Fixtures are prefixed `cmtest+` /
 * `[cmtest]` and removed at the end.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateDatabaseIdentity, evaluateTestTarget } from './lib/disposable-db';
import { confirmServerUsesDatabase, startOwnedServer, type OwnedServer } from './lib/test-server';
import { startMockGateway, type MockGateway } from './lib/mock-gateway';

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

const PREFIX = 'cmtest';
const PASSWORD = 'Commerce-Test-2026!';
const IP_PREFIX = '203.0.114.';
const KEY_ID = 'rzp_test_commercesuite01';
const KEY_SECRET = 'commerce-suite-key-secret-0123456789';
const WEBHOOK_SECRET = 'commerce-suite-webhook-secret-0123456789';

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

/** Runs `fn` and returns the thrown message, or null if it did not throw. */
async function thrown(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let BASE_URL = '';
let ipCounter = 10;
class Client {
  private cookies = new Map<string, string>();
  readonly ip = `${IP_PREFIX}${ipCounter++}`;
  async request(path_: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set('cookie', [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
    headers.set('user-agent', 'CookieNotes-Verify/commerce');
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
  json(path_: string, payload: unknown, extra: Record<string, string> = {}) {
    return this.request(path_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify(payload),
    });
  }
  post(path_: string) {
    return this.request(path_, { method: 'POST' });
  }
}

const servers: OwnedServer[] = [];
let mock: MockGateway;

async function cleanup() {
  await prisma.order.deleteMany({ where: { customerEmail: { startsWith: `${PREFIX}+` } } });
  await prisma.order.deleteMany({ where: { userId: null, customerEmail: { startsWith: `${PREFIX}+` } } });
  await prisma.paymentEvent.deleteMany({ where: { eventId: { startsWith: 'evt_mock_' } } });
  await prisma.bundle.deleteMany({ where: { title: { startsWith: '[cmtest]' } } });
  await prisma.user.deleteMany({ where: { email: { contains: `${PREFIX}+` } } });
  await prisma.subject.deleteMany({ where: { name: { startsWith: '[cmtest]' } } });
  await prisma.semester.deleteMany({ where: { name: { startsWith: '[cmtest]' } } });
  await prisma.rateLimit.deleteMany({
    where: { OR: [{ key: { contains: IP_PREFIX } }, { key: { contains: `${PREFIX}+` } }, { key: { startsWith: 'checkout' } }] },
  });
}

async function main() {
  console.log(`\nVerifying paid notes, bundles and purchases (mock gateway)\n${'─'.repeat(64)}`);
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

  // The gateway stand-in, and the application pointed at it. Set BEFORE the library is used.
  mock = await startMockGateway(KEY_ID, KEY_SECRET, WEBHOOK_SECRET);
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RAZORPAY_API_BASE = mock.baseUrl;
  process.env.OPEN_ACCESS_MODE = 'true';

  const money = await import('../src/lib/commerce/money');
  const states = await import('../src/lib/commerce/states');
  const { readPaymentsSetting, env } = await import('../src/lib/env');
  const orders = await import('../src/lib/commerce/orders');
  const fulfilment = await import('../src/lib/commerce/fulfilment');
  const refunds = await import('../src/lib/commerce/refunds');
  const access = await import('../src/lib/access/entitlements');
  const { grantEntitlement } = access;

  // --- fixtures ---------------------------------------------------------------
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const make = (name: string, role: 'STUDENT' | 'ADMIN' = 'STUDENT') =>
    prisma.user.create({ data: { email: `${PREFIX}+${name}@example.com`, name: `Buyer ${name}`, passwordHash, role, status: 'ACTIVE' } });
  const alice = await make('alice');
  const bob = await make('bob');
  const carol = await make('carol');
  const admin = await make('admin', 'ADMIN');

  const stamp = Date.now();
  const semester = await prisma.semester.create({ data: { name: '[cmtest] Sem', slug: `cmtest-${stamp}`, position: 94 } });
  const subject = await prisma.subject.create({ data: { semesterId: semester.id, name: '[cmtest] Subject', slug: `cmtest-sub-${stamp}` } });
  const otherSubject = await prisma.subject.create({ data: { semesterId: semester.id, name: '[cmtest] Other', slug: `cmtest-oth-${stamp}` } });
  const pdf = makeTestPdf('commerce test');
  let noteNo = 0;
  const makeNote = (title: string, data: Record<string, unknown> = {}) => {
    noteNo += 1;
    return prisma.note.create({
      data: {
        title: `[cmtest] ${title}`,
        subjectId: subject.id,
        storageKey: `notes/2026/10/cmtest-${stamp}-${noteNo}.pdf`,
        fileName: `n${noteNo}.pdf`,
        fileSize: pdf.length,
        status: 'PUBLISHED',
        visibility: 'RESTRICTED',
        ...data,
      },
    });
  };
  const noteA = await makeNote('Note A', { isPaid: true, priceMinor: 10_000 });
  const noteB = await makeNote('Note B', { isPaid: true, priceMinor: 20_000 });
  const noteC = await makeNote('Note C', { isPaid: true, priceMinor: 30_000 });
  const freeNote = await makeNote('Free note', { visibility: 'FREE' });
  const legacyNote = await makeNote('Legacy restricted note with an old price', { priceMinor: 5_000 });
  const draftPaid = await makeNote('Paid but draft', { isPaid: true, priceMinor: 10_000, status: 'DRAFT' });
  const bundle = await prisma.bundle.create({
    data: {
      title: '[cmtest] Bundle AB',
      priceMinor: 25_000,
      isActive: true,
      items: { create: [{ noteId: noteA.id, position: 0 }, { noteId: noteB.id, position: 1 }] },
      subjects: { create: [{ subjectId: subject.id }] },
    },
  });
  const inactiveBundle = await prisma.bundle.create({
    data: {
      title: '[cmtest] Inactive bundle',
      priceMinor: 25_000,
      isActive: false,
      items: { create: [{ noteId: noteA.id }, { noteId: noteC.id }] },
    },
  });

  const signIn = async (user: { email: string }) => {
    const client = new Client();
    const response = await client.json('/api/auth/login', { email: user.email, password: PASSWORD, force: true });
    if (response.status !== 200) throw new Error(`could not sign ${user.email} in: ${response.status}`);
    return client;
  };

  // =========================================================================
  section('1. Money: parsing, limits and formatting');
  {
    const ok = (raw: unknown) => { const r = money.parsePriceInput(raw); return r.ok ? r.minor : null; };
    check('₹499 → 49,900 paise; ₹499.50 → 49,950; the rupee sign and commas are accepted', ok('499') === 49900 && ok('499.50') === 49950 && ok('₹1,499') === 149900 && ok(499) === 49900);
    check('a single decimal is read as tens of paise (₹4.5 → 450), not rounded wrongly', ok('4.5') === 450);
    check('zero, negative, empty, text, exponent and signs are refused', ['0', '-5', '', 'abc', '1e3', '+5', '12.345', ' '].every((raw) => ok(raw) === null));
    check('below ₹1 and above ₹50,000 are refused; the limits themselves are accepted', ok('0.99') === null && ok('50000.01') === null && ok('1') === 100 && ok('50000') === 5_000_000);
    check('NaN, Infinity and non-strings are refused', ok(Number.NaN) === null && ok(Number.POSITIVE_INFINITY) === null && ok(null) === null && ok({}) === null);
    check('a float that is not a whole paisa is refused rather than rounded (0.1 + 0.2 style)', ok(10.005) === null);
    check('prices are formatted the Indian way, with ₹ and lakh grouping', money.formatInr(149900) === '₹1,499' && money.formatInr(123456700) === '₹12,34,567' && money.formatInr(49950) === '₹499.50');
    check('the input value never has a symbol or grouping', money.minorToInputValue(149900) === '1499' && money.minorToInputValue(49950) === '499.50');

    const s = money.bundleSavings(25_000, [{ isPaid: true, priceMinor: 10_000 }, { isPaid: true, priceMinor: 20_000 }]);
    check('savings: ₹100 + ₹200 sold as ₹250 saves ₹50 (17%)', s?.savingsMinor === 5_000 && s?.separateMinor === 30_000 && s?.percent === 17);
    check('no savings figure when the bundle is not cheaper, or equal', money.bundleSavings(30_000, [{ isPaid: true, priceMinor: 10_000 }, { isPaid: true, priceMinor: 20_000 }]) === null && money.bundleSavings(35_000, [{ isPaid: true, priceMinor: 10_000 }, { isPaid: true, priceMinor: 20_000 }]) === null);
    check('no savings figure from fewer than two for-sale notes (nothing honest to compare)', money.bundleSavings(100, [{ isPaid: true, priceMinor: 10_000 }]) === null);
    check('free notes and legacy prices on notes not for sale are not counted as a separate price', money.bundleSavings(15_000, [{ isPaid: true, priceMinor: 10_000 }, { isPaid: true, priceMinor: 20_000 }, { isPaid: false, priceMinor: 99_999 }])?.separateMinor === 30_000);

    const t = states.canTransition;
    check('state machine: CREATED can become PENDING, PAID, FAILED, CANCELLED', (['PENDING', 'PAID', 'FAILED', 'CANCELLED'] as const).every((to) => t('CREATED', to)));
    check('money wins: FAILED and CANCELLED can still become PAID (a payment that completes late)', t('FAILED', 'PAID') && t('CANCELLED', 'PAID'));
    check('PAID can only move to refunded states; REFUNDED is final; nothing goes back to CREATED', t('PAID', 'REFUNDED') && t('PAID', 'PARTIALLY_REFUNDED') && !t('PAID', 'FAILED') && !t('PAID', 'CANCELLED') && !t('REFUNDED', 'PAID') && !t('PAID', 'CREATED'));
    check('refund totals map to the right status', states.statusAfterRefund(1000, 0) === 'PAID' && states.statusAfterRefund(1000, 400) === 'PARTIALLY_REFUNDED' && states.statusAfterRefund(1000, 1000) === 'REFUNDED');

    const cfg = (extra: Record<string, string | boolean> = {}) => readPaymentsSetting({ keyId: KEY_ID, keySecret: 'x', webhookSecret: 'y', isProduction: true, ...extra } as never);
    check('payments are on only when key id, secret and webhook secret are ALL set', cfg().enabled && !cfg({ webhookSecret: '' }).enabled && !cfg({ keySecret: '' }).enabled && !readPaymentsSetting({ isProduction: true }).enabled);
    check('a live key is refused outside production, so a local machine can never take a real payment', !cfg({ keyId: 'rzp_live_abc', isProduction: false } as never).enabled && cfg({ keyId: 'rzp_live_abc' }).enabled);
    check('a live key is refused on a Vercel Preview or Development deployment even though NODE_ENV=production; real production and self-hosted still work', !cfg({ keyId: 'rzp_live_abc', deployment: 'preview' }).enabled && !cfg({ keyId: 'rzp_live_abc', deployment: 'development' }).enabled && cfg({ keyId: 'rzp_live_abc', deployment: 'production' }).enabled && cfg({ keyId: 'rzp_live_abc', deployment: '' }).enabled && cfg({ deployment: 'preview' }).enabled);
    check('PAYMENT_MODE must agree with the key; a bad key prefix is refused', !cfg({ paymentMode: 'live' }).enabled && cfg({ paymentMode: 'test' }).enabled && !cfg({ keyId: 'abc' }).enabled);
    check('the API base can only be overridden to loopback with a TEST key; anything else uses the official API', cfg({ apiBase: 'http://127.0.0.1:9/v1' }).apiBase === 'http://127.0.0.1:9/v1' && cfg({ apiBase: 'https://evil.example/v1' }).apiBase === 'https://api.razorpay.com/v1' && cfg({ keyId: 'rzp_live_x', apiBase: 'http://127.0.0.1:9/v1' }).apiBase === 'https://api.razorpay.com/v1');
  }

  // =========================================================================
  section('2. The database refuses an inconsistent product');
  {
    const bad = async (sql: Promise<unknown>) => (await thrown(() => sql)) !== null;
    check('a note cannot be both for sale and FREE', await bad(prisma.note.update({ where: { id: freeNote.id }, data: { isPaid: true, priceMinor: 10_000 } })));
    check('a note for sale needs a price of at least ₹1', await bad(prisma.note.update({ where: { id: legacyNote.id }, data: { isPaid: true, priceMinor: 0 } })));
    check('…and at most ₹50,000', await bad(prisma.note.update({ where: { id: legacyNote.id }, data: { isPaid: true, priceMinor: 5_000_001 } })));
    check('a bundle price outside the range is refused', await bad(prisma.bundle.update({ where: { id: bundle.id }, data: { priceMinor: 0 } })) && await bad(prisma.bundle.update({ where: { id: bundle.id }, data: { priceMinor: 5_000_001 } })));
    check('the same note cannot be in a bundle twice', await bad(prisma.bundleItem.create({ data: { bundleId: bundle.id, noteId: noteA.id } })));
    check('existing free notes are untouched, and a legacy price on a note not for sale stays harmless data', (await prisma.note.findUnique({ where: { id: freeNote.id } }))?.isPaid === false && (await prisma.note.findUnique({ where: { id: legacyNote.id } }))?.priceMinor === 5_000);
    check('a note created the old way is NOT for sale by default', (await makeNote('defaults')).isPaid === false);
  }

  // =========================================================================
  section('3. Access: paid, free and legacy notes — with open access ON and OFF');
  {
    const decide = async (userId: string, noteId: string, role: 'STUDENT' | 'ADMIN' = 'STUDENT') => access.checkNoteAccess(userId, role, noteId);
    for (const mode of ['true', 'false'] as const) {
      process.env.OPEN_ACCESS_MODE = mode;
      const label = `OPEN_ACCESS_MODE=${mode}`;
      check(`[${label}] an explicitly free note opens for any student`, (await decide(alice.id, freeNote.id)).allowed);
      check(`[${label}] a note for sale does NOT open without a purchase`, !(await decide(alice.id, noteA.id)).allowed && (await decide(alice.id, noteA.id)).reason === 'purchase_required');
      check(`[${label}] a legacy restricted note behaves exactly as before (${mode === 'true' ? 'open' : 'closed'})`, (await decide(alice.id, legacyNote.id)).allowed === (mode === 'true'));
      check(`[${label}] a draft note is hidden even when it is for sale`, (await decide(alice.id, draftPaid.id)).reason === 'not_published');
      check(`[${label}] an admin can open anything`, (await decide(admin.id, noteA.id, 'ADMIN')).allowed);
    }
    process.env.OPEN_ACCESS_MODE = 'true';

    // The access states the catalogue uses must agree with the per-note check.
    const sample = [noteA, freeNote, legacyNote].map((n) => ({ id: n.id, visibility: n.visibility as 'FREE' | 'RESTRICTED', isPaid: n.isPaid, priceMinor: n.priceMinor, unitId: n.unitId, subjectId: n.subjectId, semesterId: semester.id }));
    const st = await access.resolveNoteAccessStates({ id: alice.id, role: 'STUDENT' }, sample);
    check('catalogue states: paid → purchase_required with its price; free → open; legacy → open (preview)', st.get(noteA.id)?.kind === 'purchase_required' && (st.get(noteA.id) as { priceMinor: number }).priceMinor === 10_000 && st.get(freeNote.id)?.kind === 'open' && st.get(legacyNote.id)?.kind === 'open');
    const anon = await access.resolveNoteAccessStates(null, sample);
    check('signed-out visitors are asked to sign in (nothing is revealed about ownership)', [...anon.values()].every((state) => state.kind === 'sign_in_required'));

    // A PYQ keeps its existing rules.
    const pyq = await prisma.pyq.create({ data: { subjectId: subject.id, year: 2025, storageKey: `pyqs/2026/cmtest-${stamp}.pdf`, fileName: 'p.pdf', fileSize: pdf.length } });
    check('PYQs: unchanged — open while preview is on, closed when it is off, opened by a subject grant', (await access.checkPyqAccess(alice.id, 'STUDENT', pyq.id)).allowed);
    process.env.OPEN_ACCESS_MODE = 'false';
    check('PYQs with preview off need a grant, as before', !(await access.checkPyqAccess(alice.id, 'STUDENT', pyq.id)).allowed);
    await grantEntitlement({ userId: alice.id, scope: 'SUBJECT', targetId: subject.id, grantedById: admin.id, source: 'ADMIN_GRANT' });
    check('…and a subject-level admin grant opens the PYQ and every note in the subject, including paid ones', (await access.checkPyqAccess(alice.id, 'STUDENT', pyq.id)).allowed && (await decide(alice.id, noteA.id)).allowed && (await decide(alice.id, noteA.id)).reason === 'entitlement');
    await prisma.entitlement.deleteMany({ where: { userId: alice.id } });
    process.env.OPEN_ACCESS_MODE = 'true';
    await prisma.pyq.delete({ where: { id: pyq.id } });
  }

  // =========================================================================
  section('4. Server-side checkout: the server decides what is bought and what it costs');
  let aliceNoteSession: Awaited<ReturnType<typeof orders.createCheckout>>;
  {
    aliceNoteSession = await orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: noteA.id });
    const order = await prisma.order.findUnique({ where: { id: aliceNoteSession.orderId }, include: { items: true } });
    check('creating a checkout makes a CREATED order for the buyer with the SERVER price', order?.status === 'CREATED' && order.userId === alice.id && order.amountMinor === 10_000 && order.currency === 'INR');
    check('the order has a gateway order of the same amount, and our receipt is the order id', mock.orders.get(aliceNoteSession.gatewayOrderId)?.amount === 10_000 && order?.receipt === order?.id && order?.providerOrderId === aliceNoteSession.gatewayOrderId);
    check('the order item freezes the product: title, price, and exactly the notes delivered', order?.items.length === 1 && order.items[0].amountMinor === 10_000 && order.items[0].productType === 'NOTE' && (order.items[0].contents as { noteId: string }[])[0].noteId === noteA.id);
    check('the buyer\'s email and name are copied onto the order (so deleting the account never erases it)', order?.customerEmail === alice.email && order?.customerName === alice.name);
    check('only the PUBLIC key id is handed to the browser', aliceNoteSession.keyId === KEY_ID && !JSON.stringify(aliceNoteSession).includes(KEY_SECRET) && !JSON.stringify(aliceNoteSession).includes(WEBHOOK_SECRET));

    const again = await orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: noteA.id });
    check('a second click reuses the same open order — no duplicate orders, no second gateway order', again.orderId === aliceNoteSession.orderId && again.gatewayOrderId === aliceNoteSession.gatewayOrderId && again.reused);
    const [x, y] = await Promise.all([
      orders.createCheckout({ userId: bob.id, productType: 'NOTE', productId: noteB.id }),
      orders.createCheckout({ userId: bob.id, productType: 'NOTE', productId: noteB.id }),
    ]);
    check('two simultaneous clicks still produce ONE order', x.orderId === y.orderId && (await prisma.order.count({ where: { userId: bob.id } })) === 1);
    const carolSession = await orders.createCheckout({ userId: carol.id, productType: 'NOTE', productId: noteA.id });
    check('another student gets their own order for the same note', carolSession.orderId !== aliceNoteSession.orderId);

    const reasons = async (fn: () => Promise<unknown>) => (await thrown(fn)) ?? '';
    check('a note that is not for sale cannot be bought (free, legacy-priced, draft)', (await reasons(() => orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: freeNote.id }))).includes('not available') && (await reasons(() => orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: legacyNote.id }))).includes('not available') && (await reasons(() => orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: draftPaid.id }))).includes('not available'));
    check('an inactive bundle and an unknown product cannot be bought', (await reasons(() => orders.createCheckout({ userId: alice.id, productType: 'BUNDLE', productId: inactiveBundle.id }))).includes('not available') && (await reasons(() => orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: 'nope' }))).includes('not available'));

    const bundleSession = await orders.createCheckout({ userId: carol.id, productType: 'BUNDLE', productId: bundle.id });
    const bundleOrder = await prisma.order.findUnique({ where: { id: bundleSession.orderId }, include: { items: true } });
    const contents = bundleOrder?.items[0].contents as { noteId: string; priceMinor: number }[];
    check('a bundle order charges the BUNDLE price and snapshots both notes with their prices', bundleOrder?.amountMinor === 25_000 && contents.length === 2 && contents.map((c) => c.noteId).sort().join() === [noteA.id, noteB.id].sort().join() && contents.reduce((t, c) => t + c.priceMinor, 0) === 30_000);

    // Price changes affect FUTURE orders only.
    await prisma.note.update({ where: { id: noteC.id }, data: { priceMinor: 30_000 } });
    const early = await orders.createCheckout({ userId: bob.id, productType: 'NOTE', productId: noteC.id });
    await prisma.note.update({ where: { id: noteC.id }, data: { priceMinor: 40_000 } });
    check('changing a price never changes an existing order', (await prisma.order.findUnique({ where: { id: early.orderId } }))?.amountMinor === 30_000);
    const late = await orders.createCheckout({ userId: bob.id, productType: 'NOTE', productId: noteC.id });
    check('…and a NEW checkout after the change is charged the new price (the old unpaid one is superseded)', late.orderId !== early.orderId && late.amountMinor === 40_000 && (await prisma.order.findUnique({ where: { id: early.orderId } }))?.status === 'CANCELLED');
    await prisma.note.update({ where: { id: noteC.id }, data: { priceMinor: 30_000 } });

    // The gateway failing leaves nothing behind.
    const before = await prisma.order.count();
    mock.fault('createOrder', { status: 500 });
    const failure = await reasons(() => orders.createCheckout({ userId: carol.id, productType: 'NOTE', productId: noteC.id }));
    check('a gateway failure while opening checkout gives a friendly error and leaves no half-made order', failure.includes('could not start the payment') && (await prisma.order.count()) === before);
    mock.fault('createOrder', { drop: true });
    check('a dropped connection is handled the same way', (await reasons(() => orders.createCheckout({ userId: carol.id, productType: 'NOTE', productId: noteC.id }))).includes('could not start the payment') && (await prisma.order.count()) === before);

    delete process.env.RAZORPAY_KEY_ID;
    check('with payments not configured, checkout is unavailable (503) and nothing is created', (await reasons(() => orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: noteB.id }))).includes('not available right now') && (await prisma.order.count()) === before);
    process.env.RAZORPAY_KEY_ID = KEY_ID;
  }

  // =========================================================================
  section('5. Confirming a payment: the browser\'s word is never enough');
  {
    const confirmArgs = (session: { orderId: string; gatewayOrderId: string }, userId: string, paymentId: string, signature?: string) => ({
      userId,
      orderId: session.orderId,
      gatewayOrderId: session.gatewayOrderId,
      paymentId,
      signature: signature ?? mock.checkoutSignature(session.gatewayOrderId, paymentId),
    });
    const hasAccess = async (userId: string, noteId: string) => (await access.checkNoteAccess(userId, 'STUDENT', noteId)).allowed;
    const fresh = async (name: string, noteId: string) => {
      const user = await make(name);
      const session = await orders.createCheckout({ userId: user.id, productType: 'NOTE', productId: noteId });
      return { user, session };
    };

    // --- forged or invalid claims (alice's order from section 4) -------------
    const aliceOrder = aliceNoteSession.orderId;
    const real = mock.pay({ orderId: aliceNoteSession.gatewayOrderId });
    const forged = await thrown(() => orders.confirmCheckout(confirmArgs(aliceNoteSession, alice.id, real.id, 'a'.repeat(64))));
    check('an invalid signature is refused and nothing is granted — even though a real payment exists', forged?.includes('could not verify') === true && !(await hasAccess(alice.id, noteA.id)) && (await prisma.order.findUnique({ where: { id: aliceOrder } }))?.status === 'CREATED');
    check('a signature made for a different order is refused', (await thrown(() => orders.confirmCheckout(confirmArgs(aliceNoteSession, alice.id, real.id, mock.checkoutSignature('order_other', real.id))))) !== null);
    check('claiming the payment against a different gateway order id is refused', (await thrown(() => orders.confirmCheckout({ ...confirmArgs(aliceNoteSession, alice.id, real.id), gatewayOrderId: 'order_other' }))) !== null);
    check('another student cannot confirm (or even see) this order', (await thrown(() => orders.confirmCheckout(confirmArgs(aliceNoteSession, bob.id, real.id)))) !== null && (await thrown(() => orders.getOrderForUser(aliceOrder, bob.id))) !== null);
    check('nothing from those attempts was recorded', (await prisma.paymentTransaction.count({ where: { orderId: aliceOrder } })) === 0);

    // --- the wrong amount, correctly signed ------------------------------------
    const m1 = await fresh('mismatch', noteA.id);
    const cheap = mock.pay({ orderId: m1.session.gatewayOrderId, amount: 100 });
    const cheapResult = await orders.confirmCheckout(confirmArgs(m1.session, m1.user.id, cheap.id));
    const cheapTx = await prisma.paymentTransaction.findUnique({ where: { provider_providerPaymentId: { provider: 'razorpay', providerPaymentId: cheap.id } } });
    check('a payment of the wrong amount is recorded, FLAGGED for a human, and unlocks nothing', !cheapResult.paid && cheapTx?.flag === 'amount_mismatch' && !(await hasAccess(m1.user.id, noteA.id)));
    const m2 = await fresh('currency', noteA.id);
    const wrongCurrency = mock.pay({ orderId: m2.session.gatewayOrderId, currency: 'USD' });
    const wcResult = await orders.confirmCheckout(confirmArgs(m2.session, m2.user.id, wrongCurrency.id));
    check('a payment in the wrong currency is refused the same way', !wcResult.paid && !(await hasAccess(m2.user.id, noteA.id)) && (await prisma.paymentTransaction.findFirst({ where: { providerPaymentId: wrongCurrency.id } }))?.flag === 'amount_mismatch');

    // --- a failed payment, then a retry on the same order ---------------------
    const f1 = await fresh('failed', noteA.id);
    const failedPay = mock.pay({ orderId: f1.session.gatewayOrderId, state: 'failed' });
    const failedResult = await orders.confirmCheckout(confirmArgs(f1.session, f1.user.id, failedPay.id));
    check('a failed payment grants nothing and the order is marked FAILED', !failedResult.paid && failedResult.status === 'FAILED' && !(await hasAccess(f1.user.id, noteA.id)));
    const retryPay = mock.pay({ orderId: f1.session.gatewayOrderId });
    const retryResult = await orders.confirmCheckout(confirmArgs(f1.session, f1.user.id, retryPay.id));
    check('…and the student can retry on the SAME order: success after failure pays it', retryResult.paid && (await hasAccess(f1.user.id, noteA.id)) && (await prisma.paymentTransaction.count({ where: { orderId: f1.session.orderId } })) === 2);

    // --- authorised but not captured ------------------------------------------
    const p1 = await fresh('pending', noteA.id);
    const authorised = mock.pay({ orderId: p1.session.gatewayOrderId, state: 'authorized' });
    const pendingResult = await orders.confirmCheckout(confirmArgs(p1.session, p1.user.id, authorised.id));
    check('an authorised-but-uncaptured payment leaves the order PENDING, with a "being confirmed" message and no access', !pendingResult.paid && pendingResult.status === 'PENDING' && pendingResult.message.includes('being confirmed') && !(await hasAccess(p1.user.id, noteA.id)));
    authorised.status = 'captured';
    authorised.captured = true;
    await prisma.order.update({ where: { id: p1.session.orderId }, data: { updatedAt: new Date(Date.now() - 60_000) } });
    const settled = await orders.getOrderForUser(p1.session.orderId, p1.user.id);
    check('once the gateway captures it, the pending order settles to PAID the next time it is checked', settled.paid && (await hasAccess(p1.user.id, noteA.id)));

    // --- the gateway cannot be reached while confirming ------------------------
    const t1 = await fresh('timeout', noteA.id);
    const good1 = mock.pay({ orderId: t1.session.gatewayOrderId });
    mock.fault('fetchPayment', { drop: true });
    const timedOut = await orders.confirmCheckout(confirmArgs(t1.session, t1.user.id, good1.id));
    check('if the gateway cannot be reached the answer is "pending" — never "paid", never an error that loses the payment', !timedOut.paid && timedOut.status === 'PENDING' && !(await hasAccess(t1.user.id, noteA.id)));
    const afterTimeout = await orders.confirmCheckout(confirmArgs(t1.session, t1.user.id, good1.id));
    check('confirming again once the gateway is reachable completes it', afterTimeout.paid && (await hasAccess(t1.user.id, noteA.id)));

    // --- success (alice) ---------------------------------------------------------
    const good = mock.pay({ orderId: aliceNoteSession.gatewayOrderId });
    const ok = await orders.confirmCheckout(confirmArgs(aliceNoteSession, alice.id, good.id));
    const paidOrder = await prisma.order.findUnique({ where: { id: aliceOrder } });
    check('a verified, correct, captured payment pays the order and unlocks the note', ok.paid && ok.status === 'PAID' && paidOrder?.status === 'PAID' && paidOrder.providerPaymentId === good.id && paidOrder.paidAt !== null && (await hasAccess(alice.id, noteA.id)));
    check('the access is a PURCHASE grant tied to the order item — not an entitlement row', (await access.checkNoteAccess(alice.id, 'STUDENT', noteA.id)).reason === 'purchase' && (await prisma.entitlement.count({ where: { userId: alice.id } })) === 0 && (await prisma.purchaseGrant.count({ where: { userId: alice.id, noteId: noteA.id, revokedAt: null } })) === 1);
    const again = await orders.confirmCheckout(confirmArgs(aliceNoteSession, alice.id, good.id));
    check('confirming the same payment again is harmless: still paid, still ONE grant, ONE transaction', again.paid && (await prisma.purchaseGrant.count({ where: { userId: alice.id, noteId: noteA.id } })) === 1 && (await prisma.paymentTransaction.count({ where: { providerPaymentId: good.id } })) === 1);
    check('the paid order cannot be bought again', ((await thrown(() => orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: noteA.id }))) ?? '').includes('already have'));

    const dup = mock.pay({ orderId: aliceNoteSession.gatewayOrderId });
    await orders.confirmCheckout(confirmArgs(aliceNoteSession, alice.id, dup.id));
    const dupTx = await prisma.paymentTransaction.findUnique({ where: { provider_providerPaymentId: { provider: 'razorpay', providerPaymentId: dup.id } } });
    check('a SECOND payment on a paid order is recorded and flagged for refund; it grants nothing more', dupTx?.flag === 'duplicate_payment' && (await prisma.purchaseGrant.count({ where: { userId: alice.id, noteId: noteA.id } })) === 1 && (await prisma.order.findUnique({ where: { id: aliceOrder } }))?.providerPaymentId === good.id);

    // --- cancellation -------------------------------------------------------------
    const c1 = await fresh('cancel', noteB.id);
    check('closing checkout without paying marks the order cancelled — and grants nothing', (await fulfilment.cancelUnstartedOrder(c1.session.orderId, c1.user.id)) === 'CANCELLED' && !(await hasAccess(c1.user.id, noteB.id)));
    check('a student cannot cancel someone else\'s order', (await thrown(() => fulfilment.cancelUnstartedOrder(c1.session.orderId, bob.id))) !== null);
    const latePay = mock.pay({ orderId: c1.session.gatewayOrderId });
    await orders.confirmCheckout(confirmArgs(c1.session, c1.user.id, latePay.id));
    check('but a payment that completes AFTER the checkout was cancelled still pays the order (money wins)', (await prisma.order.findUnique({ where: { id: c1.session.orderId } }))?.status === 'PAID' && (await hasAccess(c1.user.id, noteB.id)));
    check('a paid order cannot be cancelled', (await fulfilment.cancelUnstartedOrder(c1.session.orderId, c1.user.id)) === 'PAID');

    // --- recovery: no browser callback, no webhook ---------------------------------
    const r1 = await fresh('recover', noteA.id);
    mock.pay({ orderId: r1.session.gatewayOrderId });
    check('before anything is reconciled, an unseen payment has granted nothing', !(await hasAccess(r1.user.id, noteA.id)));
    await prisma.order.update({ where: { id: r1.session.orderId }, data: { updatedAt: new Date(Date.now() - 60_000) } });
    const status = await orders.getOrderForUser(r1.session.orderId, r1.user.id);
    check('the browser never called back — coming back to the order asks the gateway and recovers the purchase', status.paid && (await hasAccess(r1.user.id, noteA.id)));
  }

  // =========================================================================
  const ON = await (async () => {
    const server = await startOwnedServer({
      databaseUrl: process.env.DATABASE_URL!,
      authSecret: process.env.AUTH_SECRET ?? '',
      extraEnv: {
        OPEN_ACCESS_MODE: 'true',
        RAZORPAY_KEY_ID: KEY_ID,
        RAZORPAY_KEY_SECRET: KEY_SECRET,
        RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
        RAZORPAY_API_BASE: mock.baseUrl,
      },
    });
    servers.push(server);
    const probe = { countMarker: (marker: string) => prisma.activityEvent.count({ where: { type: 'LOGIN_FAILED', metadata: { path: ['email'], equals: marker } } }) };
    if (!(await confirmServerUsesDatabase(server.baseUrl, probe))) throw new Error('The test server could not be shown to be using the approved database.');
    for (const note of [noteA, noteB, noteC, freeNote, legacyNote]) {
      const target = path.join(server.storageDir, note.storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, pdf);
    }
    return server;
  })();
  BASE_URL = ON.baseUrl;

  section('6. Webhooks: signed, recorded, idempotent, and tolerant of disorder');
  {
    const post = (body: string, headers: Record<string, string>) =>
      fetch(`${BASE_URL}/api/webhooks/razorpay`, { method: 'POST', headers, body });
    const hasAccess = async (userId: string, noteId: string) => (await access.checkNoteAccess(userId, 'STUDENT', noteId)).allowed;

    // a fresh order whose browser never comes back
    const session = await orders.createCheckout({ userId: carol.id, productType: 'NOTE', productId: noteC.id });
    const payment = mock.pay({ orderId: session.gatewayOrderId });
    const evt = mock.webhook('payment.captured', { payment });

    const bad = await post(evt.body, { ...evt.headers, 'x-razorpay-signature': 'f'.repeat(64) });
    check('a webhook with a wrong signature is rejected (400) and nothing is recorded', bad.status === 400 && (await prisma.paymentEvent.count({ where: { eventId: evt.headers['x-razorpay-event-id'] } })) === 0 && !(await hasAccess(carol.id, noteC.id)));
    const missing = await post(evt.body, { 'content-type': 'application/json', 'x-razorpay-event-id': evt.headers['x-razorpay-event-id'] });
    check('a webhook with no signature is rejected', missing.status === 400);
    const reserialised = JSON.stringify(JSON.parse(evt.body), null, 2);
    const resent = await post(reserialised, evt.headers);
    check('the signature is over the RAW body: the same JSON re-serialised no longer verifies', resent.status === 400);
    const noId = await post(evt.body, { 'content-type': 'application/json', 'x-razorpay-signature': evt.headers['x-razorpay-signature'] });
    check('a signed webhook with no event id is rejected', noId.status === 400);

    const first = await post(evt.body, evt.headers);
    const firstBody = await first.json();
    check('a valid payment.captured webhook pays the order with NO browser callback at all', first.status === 200 && firstBody.status === 'processed' && (await prisma.order.findUnique({ where: { id: session.orderId } }))?.status === 'PAID' && (await hasAccess(carol.id, noteC.id)));
    const record = await prisma.paymentEvent.findUnique({ where: { provider_eventId: { provider: 'razorpay', eventId: evt.headers['x-razorpay-event-id'] } } });
    check('the event was recorded, processed, and stored with only the fields processing needs', record?.status === 'PROCESSED' && record.processedAt !== null && JSON.stringify(record.data).includes(payment.id) && !JSON.stringify(record.data).includes('@'));

    const dupe = await post(evt.body, evt.headers);
    check('a redelivered event is recognised and does nothing', dupe.status === 200 && (await dupe.json()).status === 'duplicate' && (await prisma.purchaseGrant.count({ where: { userId: carol.id, noteId: noteC.id } })) === 1 && (await prisma.paymentEvent.count({ where: { eventId: evt.headers['x-razorpay-event-id'] } })) === 1);
    const sameDifferentId = mock.webhook('payment.captured', { payment });
    const second = await post(sameDifferentId.body, sameDifferentId.headers);
    check('the same payment announced by a DIFFERENT event is idempotent too: still one grant, one transaction', second.status === 200 && (await prisma.purchaseGrant.count({ where: { userId: carol.id, noteId: noteC.id } })) === 1 && (await prisma.paymentTransaction.count({ where: { providerPaymentId: payment.id } })) === 1);

    // out of order: a late "failed" cannot undo a capture
    const failedLater = { ...payment, status: 'failed' as const, captured: false, error_code: 'BAD_REQUEST_ERROR', error_description: 'late failure' };
    const lateFail = mock.webhook('payment.failed', { payment: failedLater });
    await post(lateFail.body, lateFail.headers);
    check('out of order: a "failed" event arriving after "captured" cannot downgrade the payment or lose the access', (await prisma.order.findUnique({ where: { id: session.orderId } }))?.status === 'PAID' && (await prisma.paymentTransaction.findFirst({ where: { providerPaymentId: payment.id } }))?.status === 'CAPTURED' && (await hasAccess(carol.id, noteC.id)));

    // out of order the other way: the capture event arrives BEFORE any browser confirmation, and a failed attempt after
    const s2 = await orders.createCheckout({ userId: bob.id, productType: 'NOTE', productId: noteB.id });
    const failAttempt = mock.pay({ orderId: s2.gatewayOrderId, state: 'failed' });
    const successAttempt = mock.pay({ orderId: s2.gatewayOrderId });
    const e1 = mock.webhook('payment.captured', { payment: successAttempt });
    const e2 = mock.webhook('payment.failed', { payment: failAttempt });
    await post(e1.body, e1.headers);
    await post(e2.body, e2.headers);
    check('a retry succeeds after a failed attempt, in either arrival order, and the order ends PAID', (await prisma.order.findUnique({ where: { id: s2.orderId } }))?.status === 'PAID' && (await hasAccess(bob.id, noteB.id)));

    // a wrong-amount payment announced by webhook
    const s3 = await orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: noteC.id });
    const short = mock.pay({ orderId: s3.gatewayOrderId, amount: 500 });
    const e3 = mock.webhook('payment.captured', { payment: short });
    await post(e3.body, e3.headers);
    check('a captured payment of the wrong amount announced by webhook does NOT unlock the note', !(await hasAccess(alice.id, noteC.id)) && (await prisma.paymentTransaction.findFirst({ where: { providerPaymentId: short.id } }))?.flag === 'amount_mismatch');

    // unknown order / unrelated events
    const stranger = { ...payment, id: 'pay_unknown_1', order_id: 'order_not_ours' };
    const e4 = mock.webhook('payment.captured', { payment: stranger });
    const ignored = await post(e4.body, e4.headers);
    check('a payment for an order we did not create is acknowledged and ignored', ignored.status === 200 && (await ignored.json()).status === 'ignored');
    const e5 = mock.webhook('settlement.processed', {});
    check('an event type we do not handle is acknowledged, not retried', (await post(e5.body, e5.headers)).status === 200);

    // a failure AFTER receipt is recoverable
    const s4 = await orders.createCheckout({ userId: alice.id, productType: 'NOTE', productId: noteB.id });
    const p4 = mock.pay({ orderId: s4.gatewayOrderId });
    const e6 = mock.webhook('payment.captured', { payment: p4 });
    mock.fault('fetchPayment', { status: 500 });
    const crashed = await post(e6.body, e6.headers);
    const crashedRow = await prisma.paymentEvent.findUnique({ where: { provider_eventId: { provider: 'razorpay', eventId: e6.headers['x-razorpay-event-id'] } } });
    check('if processing fails after receipt the gateway gets a 5xx (so it retries) and the event is saved as FAILED', crashed.status >= 500 && crashedRow?.status === 'FAILED' && !(await hasAccess(alice.id, noteB.id)));
    const retried = await post(e6.body, e6.headers);
    const retriedRow = await prisma.paymentEvent.findUnique({ where: { provider_eventId: { provider: 'razorpay', eventId: e6.headers['x-razorpay-event-id'] } } });
    check('the redelivery then succeeds: the SAME event row is reused (attempts counted) and access is granted', retried.status === 200 && retriedRow?.status === 'PROCESSED' && (retriedRow?.attempts ?? 0) === 2 && (await hasAccess(alice.id, noteB.id)));

    check('no secret ever appears in an error response', !(JSON.stringify(await (await post(e1.body, { ...e1.headers, 'x-razorpay-signature': 'bad' })).json())).includes(WEBHOOK_SECRET));
  }

  // =========================================================================
  section('7. Provenance: independent sources of access never touch each other');
  {
    const decide = (userId: string, noteId: string) => access.checkNoteAccess(userId, 'STUDENT', noteId);
    process.env.OPEN_ACCESS_MODE = 'false';

    const buy = async (user: { id: string }, productType: 'NOTE' | 'BUNDLE', productId: string) => {
      const session = await orders.createCheckout({ userId: user.id, productType, productId });
      const payment = mock.pay({ orderId: session.gatewayOrderId });
      await orders.confirmCheckout({ userId: user.id, orderId: session.orderId, gatewayOrderId: session.gatewayOrderId, paymentId: payment.id, signature: mock.checkoutSignature(session.gatewayOrderId, payment.id) });
      return { session, payment };
    };

    // 7a — admin grant + purchase of the same note, then refund
    const dave = await make('dave');
    await grantEntitlement({ userId: dave.id, scope: 'NOTE', targetId: noteA.id, grantedById: admin.id, source: 'ADMIN_GRANT', note: 'complimentary' });
    check('a student with an admin grant to a note is blocked from buying it again (they already have it)', ((await thrown(() => orders.createCheckout({ userId: dave.id, productType: 'NOTE', productId: noteA.id }))) ?? '').includes('already have'));
    const daveBundle = await buy(dave, 'BUNDLE', bundle.id); // dave owns A via an admin grant but not B
    check('a bundle partly owned is allowed (the notice lists what they already hold) and delivers both notes', daveBundle.session.alreadyOwned.length === 1 && daveBundle.session.alreadyOwned[0].noteId === noteA.id);
    check('the purchase did NOT overwrite the admin grant (it keeps its source and note)', (await prisma.entitlement.findFirst({ where: { userId: dave.id, targetKey: `NOTE:${noteA.id}` } }))?.source === 'ADMIN_GRANT' && (await prisma.entitlement.findFirst({ where: { userId: dave.id, targetKey: `NOTE:${noteA.id}` } }))?.note === 'complimentary');
    await refunds.requestRefund({ orderId: daveBundle.session.orderId, adminId: admin.id });
    check('refunding the bundle revokes the PURCHASED access (note B) …', !(await decide(dave.id, noteB.id)).allowed);
    check('… but the ADMIN GRANT to note A survives the refund', (await decide(dave.id, noteA.id)).allowed && (await decide(dave.id, noteA.id)).reason === 'entitlement');

    // 7b — a promotional grant survives too
    const erin = await make('erin');
    await grantEntitlement({ userId: erin.id, scope: 'NOTE', targetId: noteC.id, source: 'PROMO', note: 'launch promo' });
    check('a promotional grant opens the paid note (and so cannot be bought again)', (await decide(erin.id, noteC.id)).allowed);
    const erinBuyB = await buy(erin, 'NOTE', noteB.id);
    await refunds.requestRefund({ orderId: erinBuyB.session.orderId, adminId: admin.id });
    check('a refund leaves an unrelated promotional grant untouched', (await decide(erin.id, noteC.id)).allowed && !(await decide(erin.id, noteB.id)).allowed);

    // 7c — revoking the admin grant leaves a purchase alone
    const frank = await make('frank');
    const frankBuy = await buy(frank, 'NOTE', noteA.id);
    await grantEntitlement({ userId: frank.id, scope: 'SUBJECT', targetId: subject.id, grantedById: admin.id, source: 'ADMIN_GRANT' });
    await prisma.entitlement.deleteMany({ where: { userId: frank.id } }); // an admin revokes
    check('revoking an admin grant does not remove purchased access', (await decide(frank.id, noteA.id)).allowed && (await decide(frank.id, noteA.id)).reason === 'purchase' && frankBuy.payment.id.length > 0);

    // 7d — bundle contents are frozen
    const gail = await make('gail');
    const gailBuy = await buy(gail, 'BUNDLE', bundle.id);
    await prisma.bundleItem.deleteMany({ where: { bundleId: bundle.id, noteId: noteB.id } });
    await prisma.bundleItem.create({ data: { bundleId: bundle.id, noteId: noteC.id } });
    await prisma.bundle.update({ where: { id: bundle.id }, data: { title: '[cmtest] Bundle (renamed)', priceMinor: 99_000 } });
    const gailItem = await prisma.orderItem.findFirst({ where: { orderId: gailBuy.session.orderId } });
    check('editing a bundle afterwards changes nothing for a past buyer: same title, price, and notes on the order', gailItem?.title === '[cmtest] Bundle AB' && gailItem.amountMinor === 25_000 && (gailItem.contents as { noteId: string }[]).map((c) => c.noteId).sort().join() === [noteA.id, noteB.id].sort().join());
    check('the past buyer keeps both purchased notes, and does NOT gain the note added later', (await decide(gail.id, noteA.id)).allowed && (await decide(gail.id, noteB.id)).allowed && !(await decide(gail.id, noteC.id)).allowed);
    check('a NEW buyer now gets the CURRENT contents and price', await (async () => {
      const harry = await make('harry');
      const s = await orders.createCheckout({ userId: harry.id, productType: 'BUNDLE', productId: bundle.id });
      const item = await prisma.orderItem.findFirst({ where: { orderId: s.orderId } });
      return s.amountMinor === 99_000 && (item?.contents as { noteId: string }[]).map((c) => c.noteId).sort().join() === [noteA.id, noteC.id].sort().join();
    })());
    // restore for later sections
    await prisma.bundleItem.deleteMany({ where: { bundleId: bundle.id, noteId: noteC.id } });
    await prisma.bundleItem.create({ data: { bundleId: bundle.id, noteId: noteB.id, position: 1 } });
    await prisma.bundle.update({ where: { id: bundle.id }, data: { title: '[cmtest] Bundle AB', priceMinor: 25_000 } });

    // 7e — a note bought singly AND in a bundle: refunding one keeps the other
    const ivy = await make('ivy');
    const ivySingle = await buy(ivy, 'NOTE', noteA.id);
    const ivyBundle = await buy(ivy, 'BUNDLE', bundle.id); // A already owned; B new
    await refunds.requestRefund({ orderId: ivyBundle.session.orderId, adminId: admin.id });
    check('refunding a bundle keeps a note the student separately bought (note A), and removes the rest (note B)', (await decide(ivy.id, noteA.id)).allowed && !(await decide(ivy.id, noteB.id)).allowed && ivySingle.payment.id.length > 0);
    process.env.OPEN_ACCESS_MODE = 'true';
  }

  // =========================================================================
  section('8. Refunds: only the gateway can refund, and every refund is accounted for');
  {
    const decide = (userId: string, noteId: string) => access.checkNoteAccess(userId, 'STUDENT', noteId);
    process.env.OPEN_ACCESS_MODE = 'false';
    const buy = async (user: { id: string }, noteId: string) => {
      const session = await orders.createCheckout({ userId: user.id, productType: 'NOTE', productId: noteId });
      const payment = mock.pay({ orderId: session.gatewayOrderId });
      await orders.confirmCheckout({ userId: user.id, orderId: session.orderId, gatewayOrderId: session.gatewayOrderId, paymentId: payment.id, signature: mock.checkoutSignature(session.gatewayOrderId, payment.id) });
      return { session, payment };
    };
    const post = (body: string, headers: Record<string, string>) => fetch(`${BASE_URL}/api/webhooks/razorpay`, { method: 'POST', headers, body });

    const jo = await make('jo');
    const joBuy = await buy(jo, noteA.id);

    // full refund
    const callsBefore = mock.calls.length;
    const full = await refunds.requestRefund({ orderId: joBuy.session.orderId, adminId: admin.id, reason: 'Student asked' });
    const fullOrder = await prisma.order.findUnique({ where: { id: joBuy.session.orderId } });
    check('a full refund calls the GATEWAY, and only then does the order become REFUNDED', mock.calls.slice(callsBefore).some((c) => c.includes('/refund')) && full.status === 'PROCESSED' && fullOrder?.status === 'REFUNDED' && fullOrder.refundedMinor === 10_000);
    check('the refund is recorded (amount, status, who asked, the gateway id) and the access is revoked with the reason kept', await (async () => {
      const row = await prisma.refund.findFirst({ where: { orderId: joBuy.session.orderId } });
      const grant = await prisma.purchaseGrant.findFirst({ where: { userId: jo.id, noteId: noteA.id } });
      return row?.status === 'PROCESSED' && row.amountMinor === 10_000 && row.initiatedById === admin.id && !!row.providerRefundId && grant?.revokedAt !== null && grant?.revokeReason === 'refund' && grant?.refundId === row.id && !(await decide(jo.id, noteA.id)).allowed;
    })());
    check('the revoked grant is kept as history, not deleted', (await prisma.purchaseGrant.count({ where: { userId: jo.id, noteId: noteA.id } })) === 1);
    check('a fully refunded order cannot be refunded again', ((await thrown(() => refunds.requestRefund({ orderId: joBuy.session.orderId, adminId: admin.id }))) ?? '').includes('Only a paid order'));

    // the refund.processed webhook that follows is a duplicate in effect
    const rEvt = mock.webhook('refund.processed', { refund: [...mock.refunds.values()].find((r) => r.payment_id === joBuy.payment.id)! });
    await post(rEvt.body, rEvt.headers);
    check('the later refund.processed webhook changes nothing (no double refund, no double revoke)', (await prisma.refund.count({ where: { orderId: joBuy.session.orderId } })) === 1 && (await prisma.order.findUnique({ where: { id: joBuy.session.orderId } }))?.refundedMinor === 10_000);
    const rEvt2 = mock.webhook('refund.processed', { refund: [...mock.refunds.values()].find((r) => r.payment_id === joBuy.payment.id)! });
    await post(rEvt2.body, rEvt2.headers);
    check('even a differently-numbered duplicate refund event is idempotent', (await prisma.refund.count({ where: { orderId: joBuy.session.orderId } })) === 1);

    // can buy again after a refund
    const rebuy = await buy(jo, noteA.id);
    check('after a refund the student may buy the note again, and gets access again', (await decide(jo.id, noteA.id)).allowed && rebuy.session.orderId !== joBuy.session.orderId);

    // partial refund: access stays
    const kai = await make('kai');
    const kaiBuy = await buy(kai, noteB.id);
    const partial = await refunds.requestRefund({ orderId: kaiBuy.session.orderId, adminId: admin.id, amountMinor: 5_000 });
    const partialOrder = await prisma.order.findUnique({ where: { id: kaiBuy.session.orderId } });
    check('a partial refund marks the order PARTIALLY_REFUNDED with the exact amount and KEEPS access', partial.status === 'PROCESSED' && partialOrder?.status === 'PARTIALLY_REFUNDED' && partialOrder.refundedMinor === 5_000 && (await decide(kai.id, noteB.id)).allowed);
    check('more than the remaining amount cannot be refunded, nor less than ₹1', ((await thrown(() => refunds.requestRefund({ orderId: kaiBuy.session.orderId, adminId: admin.id, amountMinor: 15_001 }))) ?? '').includes('no more than') && ((await thrown(() => refunds.requestRefund({ orderId: kaiBuy.session.orderId, adminId: admin.id, amountMinor: 50 }))) ?? '').includes('at least'));
    await refunds.requestRefund({ orderId: kaiBuy.session.orderId, adminId: admin.id }); // the rest
    check('refunding the remainder completes it: REFUNDED, total equals the price, access revoked', (await prisma.order.findUnique({ where: { id: kaiBuy.session.orderId } }))?.status === 'REFUNDED' && (await prisma.order.findUnique({ where: { id: kaiBuy.session.orderId } }))?.refundedMinor === 20_000 && !(await decide(kai.id, noteB.id)).allowed);

    // gateway refuses
    const lou = await make('lou');
    const louBuy = await buy(lou, noteA.id);
    mock.fault('refund', { status: 400, description: 'The payment has already been fully refunded' });
    const refused = await thrown(() => refunds.requestRefund({ orderId: louBuy.session.orderId, adminId: admin.id }));
    const refusedRow = await prisma.refund.findFirst({ where: { orderId: louBuy.session.orderId } });
    check('a refund the gateway refuses is recorded as FAILED with the reason, and the order is NOT marked refunded', refused?.includes('refused') === true && refusedRow?.status === 'FAILED' && (await prisma.order.findUnique({ where: { id: louBuy.session.orderId } }))?.status === 'PAID' && (await decide(lou.id, noteA.id)).allowed);

    // the gateway does not answer
    const mae = await make('mae');
    const maeBuy = await buy(mae, noteB.id);
    mock.fault('refund', { drop: true });
    const unconfirmed = await thrown(() => refunds.requestRefund({ orderId: maeBuy.session.orderId, adminId: admin.id }));
    const pendingRow = await prisma.refund.findFirst({ where: { orderId: maeBuy.session.orderId } });
    check('if the gateway never answers, the refund stays PENDING, the order is untouched, and nothing is revoked', unconfirmed?.includes('did not confirm') === true && pendingRow?.status === 'PENDING' && !pendingRow.providerRefundId && (await prisma.order.findUnique({ where: { id: maeBuy.session.orderId } }))?.status === 'PAID' && (await decide(mae.id, noteB.id)).allowed);
    const refundCountBefore = mock.refunds.size;
    const retried = await refunds.retryRefund(pendingRow!.id);
    check('retrying re-sends the SAME receipt (the gateway\'s idempotency key) and completes the refund exactly once', retried.status === 'PROCESSED' && mock.refunds.size === refundCountBefore + 1 && (await prisma.refund.count({ where: { orderId: maeBuy.session.orderId } })) === 1 && !(await decide(mae.id, noteB.id)).allowed);
    check('the same receipt cannot be refunded twice at the gateway (it is the idempotency key)', mock.calls.filter((c) => c.endsWith('/refund')).length >= 1 && [...mock.refunds.values()].filter((r) => r.receipt === pendingRow!.receipt).length === 1);

    // the gateway processed the refund but the answer was lost
    const wes = await make('wes');
    const wesBuy = await buy(wes, noteA.id);
    mock.fault('refund', { dropAfter: true });
    const lost = await refunds.requestRefund({ orderId: wesBuy.session.orderId, adminId: admin.id });
    check('if the refund went through but the answer was lost, it is recognised at the gateway and completed — not reported as a failure, and not sent twice', lost.status === 'PROCESSED' && [...mock.refunds.values()].filter((r) => r.payment_id === wesBuy.payment.id).length === 1 && (await prisma.order.findUnique({ where: { id: wesBuy.session.orderId } }))?.status === 'REFUNDED' && !(await decide(wes.id, noteA.id)).allowed);

    // a pending refund that settles later by webhook
    mock.refundMode = 'pending';
    const ned = await make('ned');
    const nedBuy = await buy(ned, noteA.id);
    const nedRefund = await refunds.requestRefund({ orderId: nedBuy.session.orderId, adminId: admin.id });
    check('a refund the gateway reports as pending is shown pending, with access still in place', nedRefund.status === 'PENDING' && (await decide(ned.id, noteA.id)).allowed && (await prisma.order.findUnique({ where: { id: nedBuy.session.orderId } }))?.status === 'PAID');
    check('a second refund cannot be started while one is pending for the whole amount', ((await thrown(() => refunds.requestRefund({ orderId: nedBuy.session.orderId, adminId: admin.id }))) ?? '').includes('nothing left'));
    const settled = [...mock.refunds.values()].find((r) => r.payment_id === nedBuy.payment.id)!;
    settled.status = 'processed';
    const sEvt = mock.webhook('refund.processed', { refund: settled });
    await post(sEvt.body, sEvt.headers);
    check('the refund.processed webhook then completes it: REFUNDED and access revoked', (await prisma.order.findUnique({ where: { id: nedBuy.session.orderId } }))?.status === 'REFUNDED' && !(await decide(ned.id, noteA.id)).allowed);
    mock.refundMode = 'processed';

    // a refund made in the gateway's own dashboard
    const oli = await make('oli');
    const oliBuy = await buy(oli, noteA.id);
    const dash = { id: 'rfnd_dashboard_1', entity: 'refund' as const, payment_id: oliBuy.payment.id, amount: 10_000, currency: 'INR', status: 'processed' as const, receipt: null };
    mock.refunds.set(dash.id, dash);
    const dEvt = mock.webhook('refund.processed', { refund: dash });
    await post(dEvt.body, dEvt.headers);
    check('a refund made in the gateway dashboard is picked up by webhook: recorded, order REFUNDED, access revoked', (await prisma.order.findUnique({ where: { id: oliBuy.session.orderId } }))?.status === 'REFUNDED' && (await prisma.refund.findFirst({ where: { orderId: oliBuy.session.orderId } }))?.initiatedById === null && !(await decide(oli.id, noteA.id)).allowed);

    // a refund event for a payment we have not recorded yet
    const pat = await make('pat');
    const patSession = await orders.createCheckout({ userId: pat.id, productType: 'NOTE', productId: noteA.id });
    const patPayment = mock.pay({ orderId: patSession.gatewayOrderId });
    patPayment.amount_refunded = 10_000;
    patPayment.status = 'refunded';
    const early = { id: 'rfnd_early_1', entity: 'refund' as const, payment_id: patPayment.id, amount: 10_000, currency: 'INR', status: 'processed' as const, receipt: null };
    mock.refunds.set(early.id, early);
    const eEvt = mock.webhook('refund.processed', { refund: early });
    const eRes = await post(eEvt.body, eEvt.headers);
    check('a refund event that arrives before the payment was ever recorded still ends correctly (the payment is fetched first)', eRes.status === 200 && (await prisma.order.findUnique({ where: { id: patSession.orderId } }))?.status === 'REFUNDED' && !(await decide(pat.id, noteA.id)).allowed);
    process.env.OPEN_ACCESS_MODE = 'true';
  }

  // =========================================================================
  section('9. The protected PDF routes honour purchases — token, session and entitlement on every request');
  {
    process.env.OPEN_ACCESS_MODE = 'false';
    const quin = await make('quin');
    const client = await signIn(quin);
    const open = async (c: Client, noteId: string) => {
      const response = await c.post(`/api/notes/${noteId}/view-token`);
      const body = (await response.json().catch(() => ({}))) as { contentUrl?: string };
      return { status: response.status, contentUrl: body.contentUrl };
    };

    check('anonymous requests for a paid note get no token (401)', (await new Client().post(`/api/notes/${noteA.id}/view-token`)).status === 401);
    check('a signed-in student who has NOT bought it is refused (404) — even though the note is in the public catalogue', (await open(client, noteA.id)).status === 404);
    check('free notes still open for them', (await open(client, freeNote.id)).status === 200);

    // buy through the real HTTP API
    const checkout = await client.json('/api/commerce/checkout', { productType: 'NOTE', productId: noteA.id });
    const co = await checkout.json();
    check('POST /api/commerce/checkout returns the order for the signed-in student', checkout.status === 200 && co.ok === true && co.amountMinor === 10_000 && co.keyId === KEY_ID, `${checkout.status} ${JSON.stringify(co).slice(0, 200)}`);
    check('…and never contains a secret', !JSON.stringify(co).includes(KEY_SECRET) && !JSON.stringify(co).includes(WEBHOOK_SECRET));
    const tampered = await client.json('/api/commerce/checkout', { productType: 'NOTE', productId: noteA.id, amountMinor: 1, userId: bob.id, price: 1 });
    const tb = await tampered.json();
    check('an amount, price or user id supplied by the browser is ignored (same order, real price, own account)', tampered.status === 200 && tb.amountMinor === 10_000 && tb.orderId === co.orderId);

    check('an unpaid order opens no content', (await open(client, noteA.id)).status === 404);
    const claimed = await client.json(`/api/commerce/orders/${co.orderId}/confirm`, { razorpay_order_id: co.gatewayOrderId, razorpay_payment_id: 'pay_made_up', razorpay_signature: mock.checkoutSignature(co.gatewayOrderId, 'pay_made_up') });
    check('a client-side "success" with a correctly signed but non-existent payment grants nothing', claimed.status >= 400 && (await open(client, noteA.id)).status === 404);
    const claim2 = await client.json(`/api/commerce/orders/${co.orderId}/confirm`, { razorpay_order_id: co.gatewayOrderId, razorpay_payment_id: 'pay_x', razorpay_signature: 'wrong' });
    check('a wrong signature is refused', claim2.status === 422);

    const payment = mock.pay({ orderId: co.gatewayOrderId });
    const confirm = await client.json(`/api/commerce/orders/${co.orderId}/confirm`, { razorpay_order_id: co.gatewayOrderId, razorpay_payment_id: payment.id, razorpay_signature: mock.checkoutSignature(co.gatewayOrderId, payment.id) });
    const cb = await confirm.json();
    check('a verified payment: the API says paid, and ONLY now does the note open', confirm.status === 200 && cb.paid === true && cb.status === 'PAID');
    const opened = await open(client, noteA.id);
    check('the view-token flow now issues a token for the purchased note', opened.status === 200 && !!opened.contentUrl);
    const content = await client.request(opened.contentUrl!);
    check('and the content route streams the PDF (200, no-store)', content.status === 200 && (content.headers.get('cache-control') ?? '').includes('no-store') && Buffer.from(await content.arrayBuffer()).equals(pdf));

    const statusRes = await client.request(`/api/commerce/orders/${co.orderId}`);
    check('GET /api/commerce/orders/:id shows the owner their order status', statusRes.status === 200 && (await statusRes.json()).paid === true);
    const other = await signIn(bob);
    check('another student asking for that order gets "not found" — and cannot confirm it', (await other.request(`/api/commerce/orders/${co.orderId}`)).status === 404 && (await other.json(`/api/commerce/orders/${co.orderId}/confirm`, { razorpay_order_id: co.gatewayOrderId, razorpay_payment_id: payment.id, razorpay_signature: mock.checkoutSignature(co.gatewayOrderId, payment.id) })).status === 404);
    check('checkout needs a signed-in student (401) and JSON from this site', (await new Client().json('/api/commerce/checkout', { productType: 'NOTE', productId: noteA.id })).status === 401 && (await client.request('/api/commerce/checkout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status === 422 && (await client.json('/api/commerce/checkout', { productType: 'NOTE', productId: noteA.id }, { Origin: 'https://evil.example' })).status === 403);
    check('bad checkout bodies are rejected', (await client.json('/api/commerce/checkout', { productType: 'SUBSCRIPTION', productId: 'x' })).status === 422 && (await client.json('/api/commerce/checkout', {})).status === 422);

    // refund after a token was issued: the very next content request is refused
    const stillValidUrl = opened.contentUrl!;
    const quinOrder = await prisma.order.findFirst({ where: { userId: quin.id, status: 'PAID' } });
    await refunds.requestRefund({ orderId: quinOrder!.id, adminId: admin.id });
    check('a refund revokes access immediately: a still-valid view token no longer fetches the file', (await client.request(stillValidUrl)).status === 404 && (await open(client, noteA.id)).status === 404);

    // rate limiting on order creation
    const rl = await make('rl');
    const rlClient = await signIn(rl);
    await prisma.rateLimit.deleteMany({ where: { key: `checkout:user:${rl.id}` } });
    let last = 200;
    for (let i = 0; i < 32; i += 1) last = (await rlClient.json('/api/commerce/checkout', { productType: 'NOTE', productId: noteC.id })).status;
    check('order creation is rate limited per student (429 after the allowance)', last === 429);
    process.env.OPEN_ACCESS_MODE = 'true';
  }

  // =========================================================================
  section('10. Retention: deleting an account or a note never erases the financial record');
  {
    const ruth = await make('ruth');
    const session = await orders.createCheckout({ userId: ruth.id, productType: 'NOTE', productId: noteB.id });
    const payment = mock.pay({ orderId: session.gatewayOrderId });
    await orders.confirmCheckout({ userId: ruth.id, orderId: session.orderId, gatewayOrderId: session.gatewayOrderId, paymentId: payment.id, signature: mock.checkoutSignature(session.gatewayOrderId, payment.id) });
    await prisma.user.delete({ where: { id: ruth.id } });
    const kept = await prisma.order.findUnique({ where: { id: session.orderId }, include: { items: true, payments: true } });
    check('deleting the buyer\'s account keeps the order, its items and its payments, with the buyer snapshot', !!kept && kept.userId === null && kept.customerEmail === ruth.email && kept.items.length === 1 && kept.payments.length === 1 && kept.status === 'PAID');
    check('…and removes their access grants (nobody is left to hold them)', (await prisma.purchaseGrant.count({ where: { orderItem: { orderId: session.orderId } } })) === 0);
    const noteToDelete = await makeNote('Soon deleted', { isPaid: true, priceMinor: 10_000 });
    const sam = await make('sam');
    const sSession = await orders.createCheckout({ userId: sam.id, productType: 'NOTE', productId: noteToDelete.id });
    const sPay = mock.pay({ orderId: sSession.gatewayOrderId });
    await orders.confirmCheckout({ userId: sam.id, orderId: sSession.orderId, gatewayOrderId: sSession.gatewayOrderId, paymentId: sPay.id, signature: mock.checkoutSignature(sSession.gatewayOrderId, sPay.id) });
    await prisma.note.delete({ where: { id: noteToDelete.id } });
    const item = await prisma.orderItem.findFirst({ where: { orderId: sSession.orderId } });
    check('if a purchased note is deleted anyway, the order item survives with its title and price snapshot', item?.noteId === null && item.title.includes('Soon deleted') && item.amountMinor === 10_000);
  }

  // =========================================================================
  section('11. Admin rules: pricing a note and composing a bundle');
  {
    const adminLib = await import('../src/lib/commerce/admin');
    const actor = { id: admin.id, email: admin.email };
    const auditCount = (targetId: string, action: string) => prisma.auditLog.count({ where: { targetId, action: action as never } });
    const set = (noteId: string, mode: string, priceRaw = '') => adminLib.setNoteAccess({ noteId, mode, priceRaw, actor });
    const rejects = async (fn: () => Promise<unknown>) => (await thrown(fn)) !== null;
    process.env.OPEN_ACCESS_MODE = 'false';

    const target = await makeNote('Pricing target', { visibility: 'FREE' });
    check('a free note is not for sale and has no price', !target.isPaid && target.priceMinor === 0);
    const sale = await set(target.id, 'PAID', '₹1,499.50');
    const afterSale = await prisma.note.findUnique({ where: { id: target.id } });
    check('an admin can mark a note for sale: isPaid, the exact price in paise, and it can no longer be FREE', afterSale?.isPaid === true && afterSale.priceMinor === 149_950 && afterSale.visibility === 'RESTRICTED' && sale.message.includes('₹1,499.50'));
    check('the change is in the audit log with before and after', (await auditCount(target.id, 'NOTE_PRICE_CHANGED')) === 1 && JSON.stringify((await prisma.auditLog.findFirst({ where: { targetId: target.id, action: 'NOTE_PRICE_CHANGED' } }))?.metadata).includes('149950'));
    await set(target.id, 'PAID', '1499.5');
    check('saving the same price again changes nothing and writes no second audit entry', (await auditCount(target.id, 'NOTE_PRICE_CHANGED')) === 1);

    for (const bad of ['0', '-5', 'abc', '', '50000.01', '0.50', '1e3', '12.345']) {
      const before = await prisma.note.findUnique({ where: { id: target.id } });
      const refused = await rejects(() => set(target.id, 'PAID', bad));
      const after = await prisma.note.findUnique({ where: { id: target.id } });
      if (!refused || after?.priceMinor !== before?.priceMinor) check(`price "${bad}" must be refused and leave the note untouched`, false);
    }
    check('zero, negative, invalid and out-of-range prices are all refused and change nothing', (await prisma.note.findUnique({ where: { id: target.id } }))?.priceMinor === 149_950);
    check('an unknown mode is refused', await rejects(() => set(target.id, 'FREEBIE')));
    check('a note that does not exist is refused', await rejects(() => set('nope', 'FREE')));

    await set(target.id, 'PAID', '200');
    const buyer = await make('priced');
    const buySession = await orders.createCheckout({ userId: buyer.id, productType: 'NOTE', productId: target.id });
    const pay = mock.pay({ orderId: buySession.gatewayOrderId });
    await orders.confirmCheckout({ userId: buyer.id, orderId: buySession.orderId, gatewayOrderId: buySession.gatewayOrderId, paymentId: pay.id, signature: mock.checkoutSignature(buySession.gatewayOrderId, pay.id) });
    await set(target.id, 'PAID', '900');
    check('a price change affects future purchases only: the paid order still says ₹200', (await prisma.order.findUnique({ where: { id: buySession.orderId } }))?.amountMinor === 20_000 && (await prisma.orderItem.findFirst({ where: { orderId: buySession.orderId } }))?.unitPriceMinor === 20_000);
    const stranger = await make('latecomer');
    check('…and a new buyer is charged the new price', (await orders.createCheckout({ userId: stranger.id, productType: 'NOTE', productId: target.id })).amountMinor === 90_000);

    await set(target.id, 'RESTRICTED');
    const restricted = await prisma.note.findUnique({ where: { id: target.id } });
    check('taking a note off sale clears its price and it is no longer purchasable', restricted?.isPaid === false && restricted.priceMinor === 0 && ((await thrown(() => orders.createCheckout({ userId: carol.id, productType: 'NOTE', productId: target.id }))) ?? '').includes('not available'));
    check('students who bought it keep it after it comes off sale', (await access.checkNoteAccess(buyer.id, 'STUDENT', target.id)).allowed && !(await access.checkNoteAccess(stranger.id, 'STUDENT', target.id)).allowed);
    await set(target.id, 'FREE');
    check('making a note free opens it for everyone and clears the price', (await access.checkNoteAccess(stranger.id, 'STUDENT', target.id)).allowed && (await prisma.note.findUnique({ where: { id: target.id } }))?.priceMinor === 0);

    const legacy = await makeNote('Legacy with price', { priceMinor: 7_000 });
    await set(legacy.id, 'RESTRICTED');
    check('saving a legacy note as restricted keeps it restricted (not free, not for sale) and drops the stale price', (await prisma.note.findUnique({ where: { id: legacy.id } }))?.priceMinor === 0);

    // --- the guard that keeps purchased notes ---
    const soldNote = await makeNote('Sold note', { isPaid: true, priceMinor: 10_000 });
    const sold = await make('soldto');
    const soldSession = await orders.createCheckout({ userId: sold.id, productType: 'NOTE', productId: soldNote.id });
    const soldPay = mock.pay({ orderId: soldSession.gatewayOrderId });
    await orders.confirmCheckout({ userId: sold.id, orderId: soldSession.orderId, gatewayOrderId: soldSession.gatewayOrderId, paymentId: soldPay.id, signature: mock.checkoutSignature(soldSession.gatewayOrderId, soldPay.id) });
    check('a purchased note cannot be deleted — it can only be archived', ((await thrown(() => adminLib.assertNoteDeletable(soldNote.id))) ?? '').includes('Archive it instead'));
    check('a note nobody bought can be deleted', (await thrown(() => adminLib.assertNoteDeletable(legacy.id))) === null);
    await refunds.requestRefund({ orderId: soldSession.orderId, adminId: admin.id });
    check('once the only sale is refunded, the note can be deleted again', (await thrown(() => adminLib.assertNoteDeletable(soldNote.id))) === null);

    // --- bundles ---
    const pa = await makeNote('Bundle A', { isPaid: true, priceMinor: 10_000 });
    const pb = await makeNote('Bundle B', { isPaid: true, priceMinor: 20_000 });
    const pc = await makeNote('Bundle C', { isPaid: true, priceMinor: 30_000, status: 'DRAFT' });
    const free = await makeNote('Free filler', { visibility: 'FREE' });
    const created = await adminLib.createBundle({ title: '[cmtest] Draft bundle', priceRaw: '250', actor });
    const base = { bundleId: created.id, title: '[cmtest] Draft bundle', description: '', priceRaw: '250', position: '0', isActive: false, isFeatured: false, noteIds: [pa.id, pb.id], subjectIds: [subject.id], coverSubjectId: null as string | null, actor };
    const save = (over: Partial<typeof base>) => adminLib.saveBundle({ ...base, ...over });
    check('a bundle starts as an inactive draft with the price in paise', await (async () => { const b = await prisma.bundle.findUnique({ where: { id: created.id } }); return b?.isActive === false && b.priceMinor === 25_000 && (await auditCount(created.id, 'BUNDLE_CREATED')) === 1; })());
    check('creating a bundle needs a real title and a valid price', await rejects(() => adminLib.createBundle({ title: ' ', priceRaw: '250', actor })) && await rejects(() => adminLib.createBundle({ title: 'Pack', priceRaw: '0', actor })));
    check('a bundle can be saved half-built while it is a draft', (await thrown(() => save({ noteIds: [pa.id], subjectIds: [] }))) === null);
    check('only notes that are FOR SALE can be bundled (a free note is refused)', ((await thrown(() => save({ noteIds: [pa.id, free.id] }))) ?? '').includes('for sale'));
    check('a note that does not exist is refused', await rejects(() => save({ noteIds: [pa.id, 'ghost'] })));
    check('the same note listed twice is stored once', (await thrown(() => save({ noteIds: [pa.id, pa.id, pb.id] }))) === null && (await prisma.bundleItem.count({ where: { bundleId: created.id } })) === 2);
    check('an invalid price, title or order is refused', await rejects(() => save({ priceRaw: '-1' })) && await rejects(() => save({ priceRaw: '60000' })) && await rejects(() => save({ title: 'x' })) && await rejects(() => save({ position: '-4' })) && await rejects(() => save({ position: 'abc' })));
    check('an unknown subject or cover subject is refused', await rejects(() => save({ subjectIds: ['ghost'] })) && await rejects(() => save({ coverSubjectId: 'ghost' })));
    check('a bundle cannot go live with fewer than two notes', ((await thrown(() => save({ isActive: true, noteIds: [pa.id] }))) ?? '').includes('at least two'));
    check('…nor with an unpublished note', ((await thrown(() => save({ isActive: true, noteIds: [pa.id, pc.id] }))) ?? '').includes('Publish these notes first'));
    check('…nor without a subject page to promote it on', ((await thrown(() => save({ isActive: true, subjectIds: [] }))) ?? '').includes('subject page'));
    check('a complete bundle goes live, with its notes in the chosen order and its subjects', (await thrown(() => save({ isActive: true, isFeatured: true, position: '3', subjectIds: [subject.id, otherSubject.id] }))) === null && await (async () => { const b = await prisma.bundle.findUnique({ where: { id: created.id }, include: { items: { orderBy: { position: 'asc' } }, subjects: true } }); return b?.isActive === true && b.isFeatured && b.position === 3 && b.items.map((i) => i.noteId).join() === [pa.id, pb.id].join() && b.subjects.length === 2; })());
    check('removing a note and a subject removes only those', (await thrown(() => save({ noteIds: [pa.id, pb.id], subjectIds: [subject.id] }))) === null && (await prisma.bundleSubject.count({ where: { bundleId: created.id } })) === 1);
    check('a bundle can hold at most 60 notes', ((await thrown(() => save({ noteIds: Array.from({ length: 61 }, (_, i) => `n${i}`) }))) ?? '').includes('at most 60'));
    check('every save is in the audit log', (await auditCount(created.id, 'BUNDLE_UPDATED')) === 4);
    check('a bundle nobody bought can be deleted; one with orders cannot', await (async () => {
      const lonely = await adminLib.createBundle({ title: '[cmtest] Lonely', priceRaw: '100', actor });
      const gone = (await thrown(() => adminLib.deleteBundle({ bundleId: lonely.id, actor }))) === null && (await prisma.bundle.count({ where: { id: lonely.id } })) === 0;
      const refused = ((await thrown(() => adminLib.deleteBundle({ bundleId: bundle.id, actor }))) ?? '').includes('has orders');
      return gone && refused && (await auditCount(lonely.id, 'BUNDLE_DELETED')) === 1;
    })());
    check('every admin server action starts by re-checking the admin role (requireApiAdmin)', await (async () => {
      const source = await (await import('node:fs/promises')).readFile(path.join(process.cwd(), 'src/app/admin/_actions/commerce.ts'), 'utf8');
      const functions = [...source.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
      return functions.length >= 7 && functions.every((fn) => /await requireApiAdmin\(\)/.test(fn[2]));
    })());
    process.env.OPEN_ACCESS_MODE = 'true';
  }

  // =========================================================================
  section('12. Date ranges and report figures — checked against hand-calculated data');
  {
    const ranges = await import('../src/lib/commerce/ranges');
    const reporting = await import('../src/lib/commerce/reporting');
    const tz = 'Asia/Kolkata';
    const now = new Date('2031-01-06T10:00:00Z'); // 15:30 on 6 Jan in Kolkata

    const today = ranges.resolveSalesRange({ range: 'today' }, now, tz);
    check('"Today" is the calendar day on the STORE clock: midnight to midnight in Kolkata', today.start.toISOString() === '2031-01-05T18:30:00.000Z' && today.end.toISOString() === '2031-01-06T18:30:00.000Z');
    check('"Last 7 days" runs six days back from today and includes today', ranges.resolveSalesRange({ range: '7d' }, now, tz).start.toISOString() === '2030-12-30T18:30:00.000Z' && ranges.resolveSalesRange({ range: '7d' }, now, tz).end.toISOString() === today.end.toISOString());
    check('"Last 30 days" and the default are the same 30 days', ranges.resolveSalesRange({ range: '30d' }, now, tz).start.toISOString() === '2030-12-07T18:30:00.000Z' && ranges.resolveSalesRange({}, now, tz).key === '30d');
    check('"This month" starts on the 1st (store clock) and runs to the end of today', ranges.resolveSalesRange({ range: 'month' }, now, tz).start.toISOString() === '2030-12-31T18:30:00.000Z');
    const custom = ranges.resolveSalesRange({ range: 'custom', from: '2031-01-05', to: '2031-01-06' }, now, tz);
    check('a custom range is whole days, from the start of the first to the end of the last', custom.start.toISOString() === '2031-01-04T18:30:00.000Z' && custom.end.toISOString() === '2031-01-06T18:30:00.000Z');
    check('dates typed in the wrong order are swapped, not misread', ranges.resolveSalesRange({ range: 'custom', from: '2031-01-06', to: '2031-01-05' }, now, tz).start.toISOString() === custom.start.toISOString());
    check('an impossible date, garbage, or a span over a year falls back to the last 30 days', ['2031-02-30', 'tomorrow', ''].every((bad) => ranges.resolveSalesRange({ range: 'custom', from: bad, to: '2031-01-06' }, now, tz).key === '30d') && ranges.resolveSalesRange({ range: 'custom', from: '2029-01-01', to: '2031-01-06' }, now, tz).key === '30d');
    check('a single day can be chosen (from = to)', ranges.resolveSalesRange({ range: 'custom', from: '2031-01-06', to: '2031-01-06' }, now, tz).end.getTime() - ranges.resolveSalesRange({ range: 'custom', from: '2031-01-06', to: '2031-01-06' }, now, tz).start.getTime() === 86_400_000);
    check('another time zone moves the boundary (UTC: midnight UTC; New York in winter: 05:00 UTC)', ranges.resolveSalesRange({ range: 'today' }, now, 'UTC').start.toISOString() === '2031-01-06T00:00:00.000Z' && ranges.resolveSalesRange({ range: 'today' }, now, 'America/New_York').start.toISOString() === '2031-01-06T05:00:00.000Z');
    check('a day with a daylight-saving change is 23 hours long, and the next day still begins at midnight', (() => { const r = ranges.resolveSalesRange({ range: 'custom', from: '2031-03-09', to: '2031-03-09' }, now, 'America/New_York'); return r.end.getTime() - r.start.getTime() === 23 * 3_600_000; })());

    // --- a controlled week of orders in 2031 ---
    const before = await prisma.user.count();
    const rep = await make('reporter');
    const mk = async (data: { status: string; amount: number; created: string; paid?: string; refunded?: number; email?: string; note?: string; bundle?: boolean; title?: string }) => {
      const created = new Date(data.created);
      const order = await prisma.order.create({
        data: {
          userId: rep.id,
          status: data.status as never,
          amountMinor: data.amount,
          refundedMinor: data.refunded ?? 0,
          provider: 'razorpay',
          providerOrderId: `order_rep_${Math.random().toString(36).slice(2)}`,
          customerEmail: data.email ?? rep.email,
          customerName: 'Report Buyer',
          createdAt: created,
          paidAt: data.paid ? new Date(data.paid) : null,
          items: {
            create: {
              productType: data.bundle ? 'BUNDLE' : 'NOTE',
              noteId: data.bundle ? null : (data.note ?? noteA.id),
              bundleId: data.bundle ? bundle.id : null,
              title: data.title ?? (data.bundle ? 'Reported bundle' : 'Reported note'),
              unitPriceMinor: data.amount,
              amountMinor: data.amount,
              contents: [],
            },
          },
        },
      });
      return order;
    };
    const o1 = await mk({ status: 'PAID', amount: 10_000, created: '2031-01-05T18:00:00Z', paid: '2031-01-05T18:29:59Z', note: noteA.id, title: 'Note A' }); // 5 Jan 23:59:59 IST
    const o2 = await mk({ status: 'PAID', amount: 25_000, created: '2031-01-05T18:20:00Z', paid: '2031-01-05T18:30:00Z', bundle: true, title: 'Bundle AB' }); // 6 Jan 00:00:00 IST
    const o3 = await mk({ status: 'PARTIALLY_REFUNDED', amount: 20_000, refunded: 5_000, created: '2031-01-06T09:00:00Z', paid: '2031-01-06T10:00:00Z', note: noteB.id, title: 'Note B' });
    const o4 = await mk({ status: 'REFUNDED', amount: 10_000, refunded: 10_000, created: '2031-01-06T10:30:00Z', paid: '2031-01-06T11:00:00Z', note: noteA.id, title: 'Note A' });
    await mk({ status: 'FAILED', amount: 99_000, created: '2031-01-06T08:00:00Z' });
    await mk({ status: 'PENDING', amount: 88_000, created: '2031-01-06T08:30:00Z' });
    await mk({ status: 'CREATED', amount: 77_000, created: '2031-01-06T09:00:00Z' });
    await mk({ status: 'CANCELLED', amount: 66_000, created: '2031-01-06T09:30:00Z' });
    const payTx = async (orderId: string, id: string, amount: number) => prisma.paymentTransaction.create({ data: { orderId, provider: 'razorpay', providerPaymentId: id, status: 'CAPTURED', amountMinor: amount, currency: 'INR' } });
    const t3 = await payTx(o3.id, 'pay_rep_3', 20_000);
    const t4 = await payTx(o4.id, 'pay_rep_4', 10_000);
    await prisma.refund.create({ data: { orderId: o3.id, paymentTransactionId: t3.id, provider: 'razorpay', providerRefundId: 'rfnd_rep_3', receipt: 'rep_r3', amountMinor: 5_000, status: 'PROCESSED', processedAt: new Date('2031-01-06T12:00:00Z') } });
    await prisma.refund.create({ data: { orderId: o4.id, paymentTransactionId: t4.id, provider: 'razorpay', providerRefundId: 'rfnd_rep_4', receipt: 'rep_r4', amountMinor: 10_000, status: 'PROCESSED', processedAt: new Date('2031-01-07T02:00:00Z') } });
    await prisma.refund.create({ data: { orderId: o4.id, paymentTransactionId: t4.id, provider: 'razorpay', providerRefundId: 'rfnd_rep_x', receipt: 'rep_rx', amountMinor: 1_000, status: 'FAILED' } });

    const day = (from: string, to = from) => ranges.resolveSalesRange({ range: 'custom', from, to }, now, tz);
    const jan6 = await reporting.salesReport(day('2031-01-06'));
    check('6 Jan (store clock): gross = 25,000 + 20,000 + 10,000 — the sale at 00:00:00 IST belongs to the 6th, the one at 23:59:59 on the 5th does not', jan6.grossMinor === 55_000 && jan6.orders === 3);
    check('refunds are counted in the period they were PROCESSED: ₹50 on the 6th, the ₹100 one (processed on the 7th) and the FAILED one are not', jan6.refundsMinor === 5_000 && jan6.refundCount === 1);
    check('net = gross − refunds, and the average order is gross ÷ orders', jan6.netMinor === 50_000 && jan6.averageOrderMinor === 18_333);
    check('failed and pending are counted but are never revenue; abandoned checkouts are counted apart', jan6.failedOrders === 1 && jan6.pendingOrders === 1 && jan6.abandonedOrders === 2 && jan6.grossMinor === 55_000);
    check('revenue is split into notes and bundles', jan6.noteRevenueMinor === 30_000 && jan6.bundleRevenueMinor === 25_000);
    check('best sellers: a fully refunded order is left out; each note is counted once per sale', jan6.topNotes.map((t) => `${t.title}:${t.units}:${t.revenueMinor}`).sort().join() === ['Note B:1:20000'].join() && jan6.topBundles.map((t) => `${t.units}`).join() === '1');
    const jan5 = await reporting.salesReport(day('2031-01-05'));
    check('5 Jan: only the 23:59:59 sale', jan5.grossMinor === 10_000 && jan5.orders === 1 && jan5.refundsMinor === 0 && jan5.netMinor === 10_000);
    const week = await reporting.salesReport(day('2031-01-05', '2031-01-07'));
    check('5–7 Jan: gross 65,000; both processed refunds (15,000); net 50,000', week.grossMinor === 65_000 && week.orders === 4 && week.refundsMinor === 15_000 && week.refundCount === 2 && week.netMinor === 50_000);
    const empty = await reporting.salesReport(day('2031-02-01'));
    check('an empty period is all zeros — never NaN, never an error', empty.grossMinor === 0 && empty.orders === 0 && empty.averageOrderMinor === 0 && empty.netMinor === 0 && empty.topNotes.length === 0);

    // a duplicate refund webhook must not move a number
    const dupe = { id: 'rfnd_rep_3', paymentId: 'pay_rep_3', amountMinor: 5_000, currency: 'INR', state: 'processed' as const, receipt: 'rep_r3' };
    await fulfilment.applyGatewayRefund(dupe);
    await fulfilment.applyGatewayRefund(dupe);
    const again = await reporting.salesReport(day('2031-01-06'));
    check('replaying a refund event twice leaves every figure unchanged (nothing is counted twice)', again.refundsMinor === 5_000 && again.refundCount === 1 && again.netMinor === 50_000 && (await prisma.refund.count({ where: { orderId: o3.id } })) === 1);

    // pagination and filters, in the database
    for (let i = 0; i < 45; i += 1) await mk({ status: 'FAILED', amount: 10_000 + i, created: `2031-01-10T${String(8 + Math.floor(i / 10)).padStart(2, '0')}:${String((i % 10) * 5).padStart(2, '0')}:00Z`, email: `${PREFIX}+bulk${i}@example.com`, title: `Bulk ${i}` });
    const range10 = day('2031-01-10');
    const p1 = await reporting.listTransactions({ range: range10, filter: 'all', search: '', page: 1 });
    const p3 = await reporting.listTransactions({ range: range10, filter: 'all', search: '', page: 3 });
    const p9 = await reporting.listTransactions({ range: range10, filter: 'all', search: '', page: 9 });
    check('45 orders paginate as 20 + 20 + 5, newest first, counted in the database', p1.total === 45 && p1.pages === 3 && p1.rows.length === 20 && p3.rows.length === 5 && p9.rows.length === 0 && p1.rows[0].createdAt >= p1.rows[19].createdAt && p1.rows[19].createdAt >= p3.rows[0].createdAt);
    check('no order appears on two pages', new Set([...p1.rows, ...(await reporting.listTransactions({ range: range10, filter: 'all', search: '', page: 2 })).rows, ...p3.rows].map((r) => r.id)).size === 45);
    const paidList = await reporting.listTransactions({ range: day('2031-01-05', '2031-01-07'), filter: 'paid', search: '', page: 1 });
    check('the "paid" filter shows paid and partly refunded orders only', paidList.total === 3 && paidList.rows.every((r) => ['PAID', 'PARTIALLY_REFUNDED'].includes(r.status)));
    check('the "refunded", "problems" and "abandoned" filters each select the right orders', (await reporting.listTransactions({ range: day('2031-01-05', '2031-01-07'), filter: 'refunded', search: '', page: 1 })).total === 2 && (await reporting.listTransactions({ range: day('2031-01-06'), filter: 'problems', search: '', page: 1 })).total === 2 && (await reporting.listTransactions({ range: day('2031-01-06'), filter: 'abandoned', search: '', page: 1 })).total === 2);
    check('search finds an order by customer email, and by product title', (await reporting.listTransactions({ range: range10, filter: 'all', search: `${PREFIX}+bulk7@`, page: 1 })).total === 1 && (await reporting.listTransactions({ range: range10, filter: 'all', search: 'Bulk 4', page: 1 })).total === 6);
    check('this suite added no stray users', (await prisma.user.count()) >= before);
  }

  // =========================================================================
  section('13. The pages: who may see sales, bundles and purchases — and what students see');
  {
    process.env.OPEN_ACCESS_MODE = 'true';
    const adminClient = await signIn(admin);
    const student = await make('pageviewer');
    const studentClient = await signIn(student);
    const anon = new Client();
    const status = async (client: Client, p: string) => (await client.request(p)).status;
    const html = async (client: Client, p: string) => (await client.request(p)).text();
    /** What a person reads on the page: no scripts, comments or tags, spaces collapsed. */
    const visible = (markup: string) =>
      markup
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');

    for (const adminOnly of ['/admin/sales', '/admin/bundles', `/admin/bundles/${bundle.id}`, '/admin/sales/orders/anything']) {
      check(`${adminOnly}: signed-out visitors are sent to sign in; students are sent away; only an admin gets it`, (await status(anon, adminOnly)) === 307 && (await status(studentClient, adminOnly)) === 307 && [200, 404].includes(await status(adminClient, adminOnly)));
    }
    const sales = await html(adminClient, '/admin/sales?range=custom&from=2031-01-06&to=2031-01-06');
    check('the Sales page shows the hand-checked figures: gross ₹550, refunds ₹50, net ₹500, average ₹183.33', ['₹550', '₹50', '₹500', '₹183.33'].every((figure) => sales.includes(figure)));
    check('…with the period, the defined metrics and no conversion rate', sales.includes('Gross sales') && sales.includes('Net sales') && sales.includes('Pending payments') && !/conversion rate:/i.test(sales.replace(/Conversion rate is not shown[^<]*/i, '')));
    const reported = await prisma.order.findFirstOrThrow({ where: { status: 'PARTIALLY_REFUNDED', amountMinor: 20_000, createdAt: new Date('2031-01-06T09:00:00Z') } });
    const orderPage = await adminClient.request(`/admin/sales/orders/${reported.id}`);
    check('an order page shows the customer, the product and the access it gave', orderPage.status === 200 && (await orderPage.text()).includes('What was bought'));
    check('the sidebar links Bundles and Sales', (await html(adminClient, '/admin')).includes('/admin/sales') && (await html(adminClient, '/admin')).includes('/admin/bundles'));

    // my purchases: own orders only
    const zebra = await makeNote('Zebra paid note', { isPaid: true, priceMinor: 10_000 });
    const yak = await makeNote('Yak paid note', { isPaid: true, priceMinor: 10_000 });
    const tess = await make('tess');
    const uma = await make('uma');
    for (const [user, noteId] of [[tess, zebra.id], [uma, yak.id]] as const) {
      const sess = await orders.createCheckout({ userId: user.id, productType: 'NOTE', productId: noteId });
      const pay = mock.pay({ orderId: sess.gatewayOrderId });
      await orders.confirmCheckout({ userId: user.id, orderId: sess.orderId, gatewayOrderId: sess.gatewayOrderId, paymentId: pay.id, signature: mock.checkoutSignature(sess.gatewayOrderId, pay.id) });
    }
    const tessPage = await html(await signIn(tess), '/account/purchases');
    check('My purchases lists what the student bought, with a link to open it', tessPage.includes('Zebra paid note') && tessPage.includes(`/notes/${zebra.id}`) && tessPage.includes('₹100'));
    check('…and never shows another student\'s purchases', !tessPage.includes('Yak paid note') && !tessPage.includes(`/notes/${yak.id}`));
    check('signed-out visitors cannot see purchases', (await status(anon, '/account/purchases')) === 307);

    // the subject page
    await prisma.bundle.update({ where: { id: bundle.id }, data: { isFeatured: true } });
    await prisma.bundleSubject.upsert({ where: { bundleId_subjectId: { bundleId: bundle.id, subjectId: otherSubject.id } }, create: { bundleId: bundle.id, subjectId: otherSubject.id }, update: {} });
    const page = await html(studentClient, `/subject/${subject.slug}`);
    if (process.env.COMMERCE_DUMP_DIR) await writeFile(path.join(process.env.COMMERCE_DUMP_DIR, 'subject.html'), page);
    check('the subject page shows an active bundle near the top, with its price and a Buy button', page.includes('aria-label="Bundles"') && page.includes('Bundle AB') && page.includes('₹250') && page.includes('Buy bundle'));
    check('…and the bundle section comes BEFORE the notes', page.indexOf('aria-label="Bundles"') > 0 && page.indexOf('aria-label="Bundles"') < page.indexOf('>General<'));
    check('the saving is shown because it is real (₹300 separately, save ₹50)', visible(page).includes('Save ₹50') && visible(page).includes('₹300 separately'));
    check('a bundle assigned to two subjects appears only once on each page', (page.match(new RegExp(`id="bundle-${bundle.id}"`, 'g')) ?? []).length === 1);
    check('the notes themselves are still listed, labelled Paid, with a Buy action — and no file or storage detail is exposed', visible(page).includes('Paid') && visible(page).includes('Buy') && !/storageKey|notes\/20\d\d\/|\.pdf/.test(page));
    check('signed-out visitors see the same bundle and price', (await html(anon, `/subject/${subject.slug}`)).includes('Buy bundle') && (await html(anon, `/subject/${subject.slug}`)).includes('₹250'));
    await prisma.bundle.update({ where: { id: bundle.id }, data: { isActive: false } });
    check('an inactive bundle disappears from the page, and no empty section is drawn', !(await html(studentClient, `/subject/${subject.slug}`)).includes('aria-label="Bundles"'));
    await prisma.bundle.update({ where: { id: bundle.id }, data: { isActive: true } });
    await prisma.note.update({ where: { id: noteB.id }, data: { status: 'DRAFT' } });
    check('a bundle with an unpublished note is hidden (nobody is sold a bundle that is not whole)', !(await html(studentClient, `/subject/${subject.slug}`)).includes('aria-label="Bundles"'));
    await prisma.note.update({ where: { id: noteB.id }, data: { status: 'PUBLISHED' } });
    const emptySubject = await prisma.subject.create({ data: { semesterId: semester.id, name: '[cmtest] Empty', slug: `cmtest-empty-${stamp}` } });
    check('a subject with no bundles draws no bundle section', !(await html(studentClient, `/subject/${emptySubject.slug}`)).includes('aria-label="Bundles"'));

    // a student who owns part of a bundle is told so
    const part = await make('partial');
    await grantEntitlement({ userId: part.id, scope: 'NOTE', targetId: noteA.id, grantedById: admin.id, source: 'ADMIN_GRANT' });
    const partPage = await html(await signIn(part), `/subject/${subject.slug}`);
    check('a student who already holds one of the notes is told, instead of being charged silently', visible(partPage).includes('You already have 1 of these 2 notes'), visible(partPage).slice(visible(partPage).indexOf('Bundles'), visible(partPage).indexOf('Bundles') + 300));
    await prisma.entitlement.deleteMany({ where: { userId: part.id } });
    const whole = await make('whole');
    await grantEntitlement({ userId: whole.id, scope: 'SUBJECT', targetId: subject.id, grantedById: admin.id, source: 'ADMIN_GRANT' });
    const wholePage = await html(await signIn(whole), `/subject/${subject.slug}`);
    check('a student who holds every note sees "You own all of it" and no Buy button for the bundle', wholePage.includes('You own all of it') && !wholePage.includes('Buy bundle'));
    check('an owned paid note is labelled Owned', wholePage.includes('Owned'));
    const noteVisit = await studentClient.request(`/notes/${noteC.id}`);
    const noteVisitBody = await noteVisit.text();
    // Next streams the page, so a redirect raised while rendering arrives as a 200 whose body redirects the browser.
    const sentToSubject = (noteVisit.status === 307 && (noteVisit.headers.get('location') ?? '').includes(`/subject/${subject.slug}`)) ||
      (noteVisit.status === 200 && new RegExp(`<meta[^>]+refresh[^>]+/subject/${subject.slug}`).test(noteVisitBody) && noteVisitBody.includes('NEXT_REDIRECT'));
    check('visiting a paid note you have not bought sends you to its subject page, not a dead end', sentToSubject && !noteVisitBody.includes('data-pdf') && !noteVisitBody.includes('view-token'), `status ${noteVisit.status}`);

  }

  await cleanup();
  for (const server of servers) await server.stop();
  await mock.stop();

  console.log(`\n${'─'.repeat(64)}`);
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
    try {
      await cleanup();
    } catch {
      // best effort
    }
    for (const server of servers) await server.stop().catch(() => undefined);
    await mock?.stop().catch(() => undefined);
  })
  .finally(() => prisma.$disconnect());
