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
 * units from device pixels). `redColumns` makes `getImageData` return a page with red
 * vertical lines at those x ranges, so margin-line detection runs without a browser.
 */
function recordingContext(opts: { redColumns?: [number, number][]; noisyRows?: boolean; red?: [number, number, number] } = {}) {
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
    getImageData(sx: number, sy: number, sw: number, sh: number) {
      const data = new Uint8ClampedArray(sw * sh * 4).fill(255);
      const [r, g, b] = opts.red ?? [220, 40, 40];
      for (let y = 0; y < sh; y += 1) {
        for (let x = 0; x < sw; x += 1) {
          const px = sx + x;
          const red = (opts.redColumns ?? []).some(([from, to]) => px >= from && px < to);
          // Writing crossing the line: every fifth row is dark instead of red.
          const crossed = opts.noisyRows && (sy + y) % 5 === 0;
          const i = (y * sw + x) * 4;
          if (red && !crossed) { data[i] = r; data[i + 1] = g; data[i + 2] = b; }
          else if (crossed && red) { data[i] = 20; data[i + 1] = 20; data[i + 2] = 20; }
        }
      }
      return { data };
    },
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
  const { drawFooter, findMarginLine, layoutFooter, MARGIN_PROBE_WIDTH } = await import('../src/components/notes/watermark');
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
    const footer = (w: number, h: number, scale: number, marginRight: number | null = null, page = 12) => {
      const rec = recordingContext();
      drawFooter(rec.ctx, w, h, scale, REF, page, marginRight);
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
      check(`${label}: it is inside the page, on its bottom edge, equally far from the bottom and right edges`, texts(base).every((t) => t.x > 0 && t.x < w && t.y > h * 0.9 && t.y < h) && Math.abs((h - second.y) - (w - second.x)) < 1e-9, JSON.stringify(texts(base).map((t) => [t.x, t.y])));
      check(`${label}: the two pieces never overlap`, first.x + 'cookienotes.app'.length * first.fontPx * 0.55 <= second.x - second.text!.length * second.fontPx * 0.55);
      check(`${label}: no background, no rectangle, nothing drawn below the page`, base.rec.calls.every((c) => c.kind === 'text' && c.y <= h) && !base.rec.state.canvasTouched);
      check(`${label}: the transform is put back afterwards (page content is unaffected)`, base.rec.state.scale === 1);
    }

    const a4 = footer(595, 842, 3.36);
    check('semi-transparent grey ink — subtle, no opaque stamp', /^rgba\(\d+, \d+, \d+, 0\.5\)$/.test(a4.calls[0].fill), a4.calls[0].fill);
    check('its size is a fixed fraction of the page width (about 8 pt on A4) and the same for every page of that size', Math.abs(a4.calls[0].fontPx - 595 * 0.0135) < 1e-9 && footer(595, 842, 0.5).calls[0].fontPx === a4.calls[0].fontPx);
    check('and held between a floor and a ceiling in page units', footer(100, 100, 1).calls[0].fontPx === 6 && footer(5000, 3000, 1).calls[0].fontPx === 12);
    check('no reference means nothing is drawn', (() => { const r = recordingContext(); drawFooter(r.ctx, 595, 842, 1, { reference: '   ' }, 1); return r.calls.length === 0; })());
    check('and never an email address', !a4.calls.some((c) => (c.text ?? '').includes('@')));
    const lay = layoutFooter(595, 842, 'CN-7K2M9QXA · Page 3', null, (text, size) => text.length * size * 0.55);
    check('layout is a pure function of the page — the same page always gives the same layout', JSON.stringify(lay) === JSON.stringify(layoutFooter(595, 842, 'CN-7K2M9QXA · Page 3', null, (text, size) => text.length * size * 0.55)));
    check('a page too narrow for both pieces drops the left one because of the PAGE, identically at every zoom', zooms.every((z) => footer(120, 160, scaleFor(120, z, 1)).calls.length === 1));

    // --- the red margin line ---------------------------------------------------
    // The page is probed at one fixed width (MARGIN_PROBE_WIDTH), whatever the zoom; the answer is converted to page units.
    const PW = 595;
    const PH = 842;
    const probeScale = MARGIN_PROBE_WIDTH / PW;
    const lineAt = (fromPt: number, toPt: number, extra: { noisyRows?: boolean; red?: [number, number, number] } = {}) => {
      const pxFrom = Math.round(fromPt * probeScale);
      const pxTo = Math.max(pxFrom + 1, Math.round(toPt * probeScale));
      const probe = recordingContext({ redColumns: [[pxFrom, pxTo]], ...extra });
      const edge = findMarginLine(probe.ctx, MARGIN_PROBE_WIDTH, Math.round(PH * probeScale));
      return edge === null ? null : edge / probeScale;
    };
    check('no red line: the left text starts at the ordinary padding', footer(PW, PH, 2).calls.find((c) => c.align === 'left')!.x < PW * 0.05);
    for (const [label, from, to, extra] of [['a thin line', 65, 67, {}], ['a hairline anti-aliased toward white', 65, 66, { red: [240, 185, 185] as [number, number, number] }], ['a line with writing across it', 65, 67, { noisyRows: true }], ['a line far in from the left', 150, 153, {}]] as [string, number, number, { noisyRows?: boolean; red?: [number, number, number] }][]) {
      const edge = lineAt(from, to, extra);
      check(`${label}: it is found, at its right-hand edge (page units)`, edge !== null && Math.abs(edge - to) < 2, String(edge));
      const results = zooms.map((z) => footer(PW, PH, scaleFor(PW, z, 2), edge));
      check(`${label}: at every zoom the left text begins to the right of the line (never across or beneath it)`, results.every((r) => r.calls.find((c) => c.align === 'left')!.x > edge! && r.calls.length === 2));
      check(`${label}: and it is at the same page position at every zoom`, new Set(results.map((r) => r.calls.find((c) => c.align === 'left')!.x)).size === 1);
    }
    check('a double line yields its outer edge', (() => { const probe = recordingContext({ redColumns: [[88, 91], [96, 99]] }); const edge = findMarginLine(probe.ctx, MARGIN_PROBE_WIDTH, 1131); return edge === 99; })());
    check('a wide block of red is colour, not a margin line — ignored', findMarginLine(recordingContext({ redColumns: [[100, 400]] }).ctx, MARGIN_PROBE_WIDTH, 1131) === null);
    check('an unreadable canvas is treated as having no line', (() => { const u = recordingContext(); (u.ctx as unknown as { getImageData: () => never }).getImageData = () => { throw new Error('tainted'); }; return findMarginLine(u.ctx, MARGIN_PROBE_WIDTH, 1131) === null; })());
    check('a narrow page with a margin line keeps both pieces at every zoom', (() => { const edge = 33; return zooms.every((z) => { const r = footer(300, 900, scaleFor(300, z, 2), edge); return r.calls.length === 2 && r.calls.find((c) => c.align === 'left')!.x > edge; }); })());

    // --- structure: no strip, no overlay, notes and papers alike ------------------
    const { readFile } = await import('node:fs/promises');
    const pdfPage = await readFile(path.join(process.cwd(), 'src/components/notes/pdf-page.tsx'), 'utf8');
    check('no footer strip: the canvas is exactly the PDF page (height = the viewport\'s, no added height)', /canvas\.height = pixelHeight;/.test(pdfPage) && !/footerHeight|FOOTER_FRACTION|strip\b/.test(pdfPage.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')));
    check('the footer is drawn onto the page canvas under the page\'s own viewport scale — not an HTML overlay', /drawFooter\(ctx, base\.width, base\.height, viewport\.scale,/.test(pdfPage) && !/<footer|absolute.*cookienotes/i.test(pdfPage));
    const noteViewer = await readFile(path.join(process.cwd(), 'src/components/notes/note-viewer.tsx'), 'utf8');
    const notesPage = await readFile(path.join(process.cwd(), 'src/app/(reader)/notes/[id]/page.tsx'), 'utf8');
    const pyqsPage = await readFile(path.join(process.cwd(), 'src/app/(reader)/pyqs/[id]/page.tsx'), 'utf8');
    check('notes and papers use the same viewer and the same page renderer (one implementation)', /NoteViewer/.test(notesPage) && /NoteViewer/.test(pyqsPage) && /PdfPage/.test(noteViewer));
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
