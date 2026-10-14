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
 * What it cannot check is how the footer LOOKS on a real page — that is a browser
 * concern, covered by measuring real canvases at each zoom. It does check the
 * drawing code's geometry with a recording canvas: the footer is laid out in the
 * page's own units and drawn under the page's render scale, so it is identical in
 * page units at every zoom and grows and shrinks with the page; it sits on the page,
 * to the right of any red margin line, with no strip and no overlay.
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

/**
 * A canvas that records what is drawn instead of drawing it — in the units the code
 * passed, together with the transform in force at that moment (so a test can tell page
 * units from device pixels).
 */
function recordingContext() {
  type Call = { kind: 'text' | 'rect'; text?: string; x: number; y: number; align: string; fontPx: number; scale: number; fill: string };
  const calls: Call[] = [];
  const state = { font: '', fillStyle: '', textAlign: 'left', textBaseline: 'alphabetic', scale: 1, canvasTouched: false };
  const stack: number[] = [];
  const fontPx = () => Number.parseFloat(state.font);
  const ctx = {
    save() { stack.push(state.scale); },
    restore() { state.scale = stack.pop() ?? 1; },
    setTransform(a: number) { state.scale = a; },
    get font() { return state.font; }, set font(v: string) { state.font = v; },
    get fillStyle() { return state.fillStyle; }, set fillStyle(v: string) { state.fillStyle = v; },
    get textAlign() { return state.textAlign; }, set textAlign(v: string) { state.textAlign = v; },
    get textBaseline() { return state.textBaseline; }, set textBaseline(v: string) { state.textBaseline = v; },
    get canvas() { state.canvasTouched = true; return {}; },
    // Like a real canvas, the width is in the font's own units — it does not depend on the transform.
    // Roughly 0.55 em per character, like a proportional sans-serif.
    measureText(text: string) { return { width: text.length * fontPx() * 0.55 }; },
    fillText(text: string, x: number, y: number) { calls.push({ kind: 'text', text, x, y, align: state.textAlign, fontPx: fontPx(), scale: state.scale, fill: state.fillStyle }); },
    fillRect(x: number, y: number) { calls.push({ kind: 'rect', x, y, align: state.textAlign, fontPx: fontPx(), scale: state.scale, fill: state.fillStyle }); },
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
  const { drawFooter, layoutFooter, NOTEBOOK_MARGIN_FRACTION, NOTEBOOK_IS_DARK } = await import('../src/components/notes/watermark');
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

  section('3. The footer is printed in page units, so it scales with the page');
  {
    const REF = { reference: 'CN-7K2M9QXA' };
    // Page sizes in PDF points: A4, A4 landscape, US Letter, tall narrow, wide short, a small page.
    const pages = [['A4 portrait', 595, 842], ['A4 landscape', 842, 595], ['US Letter', 612, 792], ['a tall narrow page', 300, 900], ['a wide short slide', 900, 300], ['a small page', 240, 320]] as const;
    const zooms = [0.5, 0.75, 1, 1.25, 1.5, 1.75];
    // What the viewer does: fit the page to ~1000 CSS px, times the zoom, times the device pixel ratio.
    const scaleFor = (pageWidth: number, zoom: number, dpr: number) => ((1000 * zoom) / pageWidth) * dpr;
    // `footer` draws with explicit options (no margin line, light page unless said otherwise); `formatted` uses the notes' format defaults.
    const footer = (w: number, h: number, scale: number, marginRight: number | null = null, page = 12, dark = false) => {
      const rec = recordingContext();
      drawFooter(rec.ctx, w, h, scale, REF, page, marginRight, dark);
      return rec;
    };
    const formatted = (w: number, h: number, scale: number, page = 12) => {
      const rec = recordingContext();
      drawFooter(rec.ctx, w, h, scale, REF, page);
      return rec;
    };

    for (const [label, w, h] of pages) {
      const runs = zooms.flatMap((zoom) => [1, 2].map((dpr) => ({ zoom, dpr, scale: scaleFor(w, zoom, dpr), rec: footer(w, h, scaleFor(w, zoom, dpr)) })));
      const base = runs.find((r) => r.zoom === 1 && r.dpr === 1)!;
      const texts = (r: (typeof runs)[number]) => r.rec.calls.filter((c) => c.kind === 'text');
      const key = (r: (typeof runs)[number]) => JSON.stringify(texts(r).map((t) => [t.text, t.x, t.y, t.align, t.fontPx]));

      check(`${label}: at 50%, 75%, 100%, 125%, 150% and 175% (and 1x/2x screens) the footer is identical in page units — same text, positions, font size`, runs.every((r) => key(r) === key(base)), key(base));
      check(`${label}: both pieces are there at every zoom — neither disappears`, runs.every((r) => texts(r).length === 2));
      check(`${label}: it is drawn under the page's own scale — the transform equals the render scale at every zoom`, runs.every((r) => texts(r).every((t) => t.scale === r.scale)));
      check(`${label}: so on the canvas its device size is the page-unit size times the scale (it grows and shrinks with the page)`, runs.every((r) => texts(r).every((t) => Math.abs(t.fontPx * t.scale - base.rec.calls[0].fontPx * r.scale) < 1e-9)));
      const doubled = runs.find((r) => r.zoom === 1.5 && r.dpr === 1)!;
      const half = runs.find((r) => r.zoom === 0.75 && r.dpr === 1)!;
      check(`${label}: at 150% the footer is exactly twice as big on the canvas as at 75%`, Math.abs((texts(doubled)[0].fontPx * doubled.scale) / (texts(half)[0].fontPx * half.scale) - 2) < 1e-9);
      check(`${label}: and it sits at the same fraction of the page at every zoom (relative position unchanged)`, runs.every((r) => texts(r).every((t, i) => Math.abs((t.x * t.scale) / (w * r.scale) - texts(base)[i].x / w) < 1e-9 && Math.abs((t.y * t.scale) / (h * r.scale) - texts(base)[i].y / h) < 1e-9)));

      const [first, second] = ['left', 'right'].map((side) => texts(base).find((t) => t.align === side)!);
      check(`${label}: the site on the left, the reference and page number on the right`, first?.text === 'cookienotes.app' && second?.text === 'CN-7K2M9QXA · Page 12');
      check(`${label}: it is inside the page, on its bottom edge, with the bottom padding at 1.5% of the width and the right padding at 3%`, texts(base).every((t) => t.x > 0 && t.x < w && t.y > h * 0.9 && t.y < h) && Math.abs((h - second.y) - Math.max(6, w * 0.015)) < 1e-9 && Math.abs((w - second.x) - Math.max(10, w * 0.03)) < 1e-9, JSON.stringify(texts(base).map((t) => [t.x, t.y])));
      check(`${label}: the two pieces never overlap`, first.x + 'cookienotes.app'.length * first.fontPx * 0.55 <= second.x - second.text!.length * second.fontPx * 0.55);
      check(`${label}: no background, no rectangle, nothing drawn below the page`, base.rec.calls.every((c) => c.kind === 'text' && c.y <= h) && !base.rec.state.canvasTouched);
      check(`${label}: the transform is put back afterwards (page content is unaffected)`, base.rec.state.scale === 1);
    }

    const a4 = footer(595, 842, 3.36);
    check('semi-transparent grey ink — subtle, no opaque stamp', /^rgba\(\d+, \d+, \d+, 0\.5\)$/.test(a4.calls[0].fill), a4.calls[0].fill);
    check('its size is a fixed fraction of the page width (about 11 pt on A4) and the same for every page of that size', Math.abs(a4.calls[0].fontPx - 595 * 0.019) < 1e-9 && footer(595, 842, 0.5).calls[0].fontPx === a4.calls[0].fontPx);
    check('and held between a floor and a ceiling in page units', footer(100, 100, 1).calls[0].fontPx === 8 && footer(5000, 3000, 1).calls[0].fontPx === 16);
    check('no reference means nothing is drawn', (() => { const r = recordingContext(); drawFooter(r.ctx, 595, 842, 1, { reference: '   ' }, 1); return r.calls.length === 0; })());
    check('and never an email address', !a4.calls.some((c) => (c.text ?? '').includes('@')));
    const lay = layoutFooter(595, 842, 'CN-7K2M9QXA · Page 3', null, (text, size) => text.length * size * 0.55);
    check('layout is a pure function of the page — the same page always gives the same layout', JSON.stringify(lay) === JSON.stringify(layoutFooter(595, 842, 'CN-7K2M9QXA · Page 3', null, (text, size) => text.length * size * 0.55)));
    check('a page too narrow for both pieces drops the left one because of the PAGE, identically at every zoom', zooms.every((z) => footer(120, 160, scaleFor(120, z, 1)).calls.length === 1));

    // --- the notes' format: margin line and ink are constants, not worked out per page ---------
    check('the format is: margin line edge at 14.25% of the page width, dark pages', NOTEBOOK_MARGIN_FRACTION === 0.1425 && NOTEBOOK_IS_DARK === true);
    const fmtPages = [['A4 portrait', 595, 842], ['A4 landscape', 842, 595], ['US Letter', 612, 792], ['a tall narrow page', 300, 900]] as const;
    for (const [label, w, h] of fmtPages) {
      const runs = zooms.map((z) => formatted(w, h, scaleFor(w, z, 2)));
      const left = (r: ReturnType<typeof formatted>) => r.calls.find((c) => c.align === 'left');
      check(`${label}: by default the left text begins to the right of the margin line (${(NOTEBOOK_MARGIN_FRACTION * 100).toFixed(2)}% of the width) at every zoom`, runs.every((r) => !!left(r) && left(r)!.x > w * NOTEBOOK_MARGIN_FRACTION && r.calls.length === 2), String(left(runs[0])?.x));
      check(`${label}: and at the same page position at every zoom`, new Set(runs.map((r) => left(r)!.x)).size === 1);
      check(`${label}: by default it uses the light ink (same 50% opacity) for the format's dark pages`, runs.every((r) => r.calls.every((c) => c.fill === 'rgba(225, 225, 225, 0.5)')));
    }
    check('overrides still work: no margin line starts the text at the plain padding, and a light page gets the dark-grey ink', footer(595, 842, 2).calls.find((c) => c.align === 'left')!.x < 595 * 0.05 && footer(595, 842, 2).calls.every((c) => c.fill === 'rgba(55, 55, 55, 0.5)'));
    check('the ink does not change geometry — same positions either way', JSON.stringify(formatted(595, 842, 2, 1).calls.map((c) => [c.text, c.fontPx, c.y])) === JSON.stringify(footer(595, 842, 2, null, 1, true).calls.map((c) => [c.text, c.fontPx, c.y])));
    check('a narrow page keeps both pieces at every zoom with the margin line', zooms.every((z) => { const r = formatted(300, 900, scaleFor(300, z, 2)); return r.calls.length === 2 && r.calls.find((c) => c.align === 'left')!.x > 300 * NOTEBOOK_MARGIN_FRACTION; }));

    // --- structure: no strip, no overlay, notes and papers alike ------------------
    const { readFile } = await import('node:fs/promises');
    const pdfPage = await readFile(path.join(process.cwd(), 'src/components/notes/pdf-page.tsx'), 'utf8');
    check('no footer strip: the canvas is exactly the PDF page (height = the viewport\'s, no added height)', /canvas\.height = pixelHeight;/.test(pdfPage) && !/footerHeight|FOOTER_FRACTION|strip\b/.test(pdfPage.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')));
    check('the page is rendered once only — no extra off-screen render', (pdfPage.match(/page\.render\(/g) ?? []).length === 1);
    check('no per-page work at all: nothing is read back from the canvas, scanned or rendered twice — the margin line and ink are constants of the format', !/getImageData|findMarginLine|pageIsDark|lookAtPage|createElement\('canvas'\)/.test(pdfPage) && /await task\.promise;[\s\S]*drawFooter\(/.test(pdfPage));
    check('the footer is drawn onto the page canvas under the page\'s own viewport scale — not an HTML overlay', /drawFooter\(ctx, base\.width, base\.height, viewport\.scale,/.test(pdfPage) && !/<footer|absolute.*cookienotes/i.test(pdfPage));
    const noteViewer = await readFile(path.join(process.cwd(), 'src/components/notes/note-viewer.tsx'), 'utf8');
    const notesPage = await readFile(path.join(process.cwd(), 'src/app/(reader)/notes/[id]/page.tsx'), 'utf8');
    const pyqsPage = await readFile(path.join(process.cwd(), 'src/app/(reader)/pyqs/[id]/page.tsx'), 'utf8');
    check('notes and papers use the same viewer and the same page renderer (one implementation)', /NoteViewer/.test(notesPage) && /NoteViewer/.test(pyqsPage) && /PdfPage/.test(noteViewer));
    check('pdf.js and its worker start loading BEFORE the token request and the download, in parallel with them, and the worker is handed to the document', (() => { const engine = noteViewer.indexOf("import('pdfjs-dist')"); const token = noteViewer.indexOf('fetch(`${apiBase}/${noteId}/view-token`'); const content = noteViewer.indexOf('fetch(open.contentUrl'); return engine > 0 && engine < token && token < content && /new pdfjs\.PDFWorker\(\)/.test(noteViewer) && /getDocument\(\{[\s\S]*?\bworker,/.test(noteViewer); })());
    check('access is unchanged by that: the token is still requested first and the bytes fetched only from the URL it returns', /view-token`,\s*\{\s*method: 'POST',\s*cache: 'no-store'/.test(noteViewer) && /fetch\(open\.contentUrl, \{ cache: 'no-store' \}\)/.test(noteViewer));
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
