/**
 * End-to-end verification of the security-critical user journeys.
 *
 *   npm run build && npm run start        # in one terminal
 *   npm run verify:flows                  # in another
 *
 * Everything below runs against a real HTTP server with real cookies, a real
 * database and real files in storage. Nothing is mocked. Test accounts use the
 * `flowtest+…@scholarvault.test` prefix and are removed before each run.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { makeTestPdf } from './make-test-pdf';

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';

/**
 * Whether the server under test is running in open preview.
 *
 * Read from the same .env the server was started with. In preview mode a
 * signed-in student can open any published note, so the entitlement-gating
 * assertions are replaced by preview-specific ones. Run
 *   OPEN_ACCESS_MODE=false npm run build && OPEN_ACCESS_MODE=false npm run start
 * to exercise the strict matrix.
 */
const PREVIEW_MODE = (process.env.OPEN_ACCESS_MODE ?? 'true') !== 'false';
const PREFIX = 'flowtest';
const STUDENT_EMAIL = `${PREFIX}+student@scholarvault.test`;
const OTHER_EMAIL = `${PREFIX}+other@scholarvault.test`;
const ADMIN_EMAIL = `${PREFIX}+admin@scholarvault.test`;
const PASSWORD = 'Verify-Flows-2026!';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

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

/** A browser-ish client: keeps its own cookie jar and never follows redirects. */
class Client {
  private cookies = new Map<string, string>();

  constructor(readonly label: string) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        'cookie',
        [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; '),
      );
    }
    headers.set('user-agent', `ScholarVault-Verify/${this.label}`);
    headers.set('x-forwarded-for', '203.0.113.7');

    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
      redirect: 'manual',
    });

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

  hasSession() {
    return this.cookies.has('sv_session');
  }

  clearCookies() {
    this.cookies.clear();
  }
}

/** Any draft note in the database, for the "drafts are invisible" assertion. */
async function draftNoteId(): Promise<string | null> {
  const draft = await prisma.note.findFirst({ where: { status: 'DRAFT' }, select: { id: true } });
  return draft?.id ?? null;
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

// ---------------------------------------------------------------------------

async function cleanup() {
  await prisma.user.deleteMany({ where: { email: { contains: `${PREFIX}+` } } });
  await prisma.note.deleteMany({ where: { title: { startsWith: '[verify]' } } });
  await prisma.subject.deleteMany({ where: { name: { startsWith: '[verify]' } } });
  await prisma.semester.deleteMany({ where: { name: { startsWith: '[verify]' } } });
  await prisma.rateLimit.deleteMany({
    where: { OR: [{ key: { contains: PREFIX } }, { key: { contains: '203.0.113.7' } }] },
  });
}

async function main() {
  console.log(`\nVerifying Cookie Notes flows against ${BASE_URL}\n${'─'.repeat(56)}`);

  // Fail fast with a helpful message if the server is not up.
  try {
    await fetch(`${BASE_URL}/login`, { redirect: 'manual' });
  } catch {
    console.error(
      `\nCould not reach ${BASE_URL}.\nStart the app first (npm run dev, or npm run build && npm run start).\n`,
    );
    process.exit(1);
  }

  await cleanup();

  // --- fixtures ------------------------------------------------------------
  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      name: 'Verify Admin',
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });

  const semester = await prisma.semester.create({
    data: { name: '[verify] Semester', slug: `verify-semester-${Date.now()}`, position: 99 },
  });
  const subject = await prisma.subject.create({
    data: {
      semesterId: semester.id,
      name: '[verify] Subject',
      slug: `verify-subject-${Date.now()}`,
      code: 'VER101',
    },
  });
  const unit = await prisma.unit.create({
    data: { subjectId: subject.id, name: 'Unit 1', position: 0 },
  });

  const studentA = new Client('studentA');
  const studentB = new Client('studentB');
  const adminClient = new Client('admin');
  const outsider = new Client('outsider');

  // --- 0. The public catalogue ---------------------------------------------
  section('0. Public catalogue');
  {
    const visitor = new Client('visitor');

    const home = await visitor.request('/');
    check('the home page is public', home.status === 200, `status ${home.status}`);

    const html = await home.text();
    check(
      'the catalogue renders content, not a login wall',
      !/Welcome back|Sign in to open your notes/.test(html),
    );

    const subjectPage = await visitor.request(`/subject/${subject.slug}`);
    check('a subject page is public', subjectPage.status === 200, `status ${subjectPage.status}`);

    const subjectHtml = await subjectPage.text();
    check('the subject page shows the structure to a visitor', subjectHtml.includes(subject.name));
    check(
      'no storage key or file name leaks into the public page',
      !subjectHtml.includes('notes/20') && !subjectHtml.includes('.pdf'),
    );

    // Reading is still gated.
    const reader = await visitor.request('/notes/does-not-exist');
    check(
      'the reader redirects an anonymous visitor to sign in',
      reader.status === 307 || reader.status === 302,
      `status ${reader.status}`,
    );
    check(
      'and remembers where they were going',
      (reader.headers.get('location') ?? '').includes('next='),
      reader.headers.get('location') ?? '',
    );

    // Retired V1 destinations must be gone, not broken.
    for (const path of ['/dashboard', '/subjects', '/search']) {
      const response = await visitor.request(path);
      check(
        `${path} is retired`,
        response.status === 404 || response.status === 307 || response.status === 302,
        `status ${response.status}`,
      );
    }
  }

  // --- 1. Registration -----------------------------------------------------
  section('1. Registration');
  {
    const response = await studentA.json('/api/auth/register', {
      name: 'Verify Student',
      email: STUDENT_EMAIL,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      college: 'Verification College',
    });
    check('student can register', response.status === 201, `status ${response.status}`);
    check('registration sets a session cookie', studentA.hasSession());

    const created = await prisma.user.findUnique({ where: { email: STUDENT_EMAIL } });
    check('account is persisted with STUDENT role', created?.role === 'STUDENT');
    check(
      'password is stored as a bcrypt hash, never in plain text',
      Boolean(created && created.passwordHash.startsWith('$2') && !created.passwordHash.includes(PASSWORD)),
    );
  }

  // --- 2. Duplicate registration ------------------------------------------
  section('2. Duplicate account');
  {
    const response = await outsider.json('/api/auth/register', {
      name: 'Impostor',
      email: STUDENT_EMAIL,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
    check('second registration with the same email is rejected', response.status === 409);
    const data = await body<{ error?: string }>(response);
    check(
      'the rejection message is user-friendly',
      Boolean(data.error && !/prisma|constraint|sql/i.test(data.error)),
      data.error,
    );
  }

  // --- 3. Weak password ----------------------------------------------------
  section('3. Password policy');
  {
    const response = await outsider.json('/api/auth/register', {
      name: 'Weak',
      email: OTHER_EMAIL,
      password: 'password',
      confirmPassword: 'password',
    });
    check('a weak password is rejected', response.status === 422);
  }

  // --- 4. One active session per account -----------------------------------
  section('4. One active session per account');
  {
    const conflict = await studentB.json('/api/auth/login', {
      email: STUDENT_EMAIL,
      password: PASSWORD,
    });
    const conflictBody = await body<{ code?: string; details?: { device?: string } }>(conflict);
    check('a second device is blocked while a session is live', conflict.status === 409);
    check('the block is reported as a session conflict', conflictBody.code === 'session_conflict');
    check('the other device is described to the user', Boolean(conflictBody.details?.device));
    check('no cookie is issued to the blocked device', !studentB.hasSession());

    const forced = await studentB.json('/api/auth/login', {
      email: STUDENT_EMAIL,
      password: PASSWORD,
      force: true,
    });
    check('the user can take over the session deliberately', forced.status === 200);
    check('the new device receives a session', studentB.hasSession());

    const oldHeartbeat = await studentA.request('/api/session/heartbeat', { method: 'POST' });
    const oldBody = await body<{ status?: string }>(oldHeartbeat);
    check('the previous device is signed out immediately', oldHeartbeat.status === 401);
    check('it is told why', oldBody.status === 'superseded', oldBody.status);

    const activeSessions = await prisma.session.count({
      where: { user: { email: STUDENT_EMAIL }, status: 'ACTIVE' },
    });
    check('exactly one session row remains active', activeSessions === 1, `${activeSessions} active`);
  }

  // --- 5. Wrong password ---------------------------------------------------
  section('5. Invalid credentials');
  {
    const response = await outsider.json('/api/auth/login', {
      email: STUDENT_EMAIL,
      password: 'Definitely-Wrong-1!',
    });
    check('a wrong password is rejected', response.status === 422);
    const data = await body<{ error?: string }>(response);
    check(
      'the error does not reveal whether the account exists',
      Boolean(data.error && !/no account|not found|unknown user/i.test(data.error)),
      data.error,
    );
  }

  // --- 6. Admin authentication and route protection ------------------------
  section('6. Admin authorisation');
  {
    const login = await adminClient.json('/api/auth/login', {
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    const loginBody = await body<{ redirectTo?: string }>(login);
    check('admin can sign in', login.status === 200);
    check('admin lands on the admin area', loginBody.redirectTo === '/admin');

    const studentOnAdminPage = await studentB.request('/admin');
    check(
      'a student hitting /admin is redirected away',
      studentOnAdminPage.status === 307 || studentOnAdminPage.status === 302,
      `status ${studentOnAdminPage.status}`,
    );
    check(
      'the redirect goes back to the catalogue',
      new URL(
        studentOnAdminPage.headers.get('location') ?? 'http://x/none',
        BASE_URL,
      ).pathname === '/',
      studentOnAdminPage.headers.get('location') ?? 'no location header',
    );
    const adminHtml = await studentOnAdminPage.text();
    check(
      'no admin content is sent to a student',
      !/Total students|Most active students|Grant access/i.test(adminHtml),
    );

    const studentOnAdminApi = await studentB.json('/api/admin/uploads/presign', {
      fileName: 'x.pdf',
      contentType: 'application/pdf',
    });
    check(
      'a student calling an admin API is refused',
      studentOnAdminApi.status === 404,
      `status ${studentOnAdminApi.status}`,
    );

    const anonymousOnAdminApi = await new Client('anon').json('/api/admin/uploads/presign', {});
    check('an anonymous admin API call is refused', anonymousOnAdminApi.status === 401);
  }

  // --- 7. Note upload ------------------------------------------------------
  section('7. Note upload');
  let noteId = '';
  {
    const pdf = makeTestPdf('[verify] Unit 1 — Introduction');
    const form = new FormData();
    form.append('title', '[verify] Unit 1 — Introduction');
    form.append('description', 'Uploaded by the automated flow verification.');
    form.append('subjectId', subject.id);
    form.append('unitId', unit.id);
    form.append('status', 'PUBLISHED');
    form.append('visibility', 'RESTRICTED');
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'verify.pdf');

    const response = await adminClient.request('/api/admin/notes', { method: 'POST', body: form });
    const data = await body<{ noteId?: string; error?: string }>(response);
    check('admin can upload a PDF', response.status === 201, data.error);
    noteId = data.noteId ?? '';

    const note = noteId ? await prisma.note.findUnique({ where: { id: noteId } }) : null;
    check('the note row is created', Boolean(note));
    check(
      'the file is stored under an opaque private key, not a public path',
      Boolean(note && note.storageKey.startsWith('notes/') && !note.storageKey.includes('public')),
    );
    check('a checksum is recorded', Boolean(note?.checksum));
    check('version 1 is recorded in history', Boolean(note && note.version === 1));

    // A non-PDF must be rejected.
    const badForm = new FormData();
    badForm.append('title', '[verify] Not a PDF');
    badForm.append('subjectId', subject.id);
    badForm.append('file', new Blob([new Uint8Array(Buffer.alloc(2048, 0x41))], { type: 'application/pdf' }), 'fake.pdf');
    const badResponse = await adminClient.request('/api/admin/notes', {
      method: 'POST',
      body: badForm,
    });
    check('a file that is not really a PDF is rejected', badResponse.status === 422);
  }

  if (!noteId) {
    console.error('\nUpload failed, so the access-control checks cannot run.');
    await finish();
    return;
  }

  // --- 8. Access control ---------------------------------------------------
  section(`8. Note authorisation (${PREVIEW_MODE ? 'open preview' : 'strict'})`);
  {
    const noGrant = await studentB.request(`/api/notes/${noteId}/view-token`, { method: 'POST' });

    if (PREVIEW_MODE) {
      check(
        'open preview lets a signed-in student without a grant open a published note',
        noGrant.status === 200,
        `status ${noGrant.status}`,
      );
      const student = await prisma.user.findUniqueOrThrow({ where: { email: STUDENT_EMAIL } });
      const grants = await prisma.entitlement.count({ where: { userId: student.id } });
      check('and they genuinely hold no entitlement', grants === 0, `${grants} grants`);
    } else {
      check(
        'a student without a grant cannot open the note',
        noGrant.status === 404,
        `status ${noGrant.status}`,
      );
    }

    // These hold in both modes: preview relaxes *who* may read, never *how*.
    const forged = await studentB.request(`/api/notes/${noteId}/content?t=forged.token`);
    check('a forged view token is refused', forged.status === 403 || forged.status === 404,
      `status ${forged.status}`);

    const anonymousToken = await new Client('anon1').request(`/api/notes/${noteId}/view-token`, {
      method: 'POST',
    });
    check('an anonymous view-token request is refused', anonymousToken.status === 401);

    const anonymousContent = await new Client('anon2').request(`/api/notes/${noteId}/content`);
    check('an anonymous content request is refused', anonymousContent.status === 401);

    const draftId = await draftNoteId();
    if (draftId) {
      const draft = await studentB.request(`/api/notes/${draftId}/view-token`, { method: 'POST' });
      check('a DRAFT note is never readable by a student', draft.status === 404, `status ${draft.status}`);
    }

    const suspicious = await prisma.activityEvent.count({
      where: { type: 'SUSPICIOUS_ACTIVITY', noteId },
    });
    check('unauthorised content attempts are logged', suspicious > 0, `${suspicious} events`);
  }

  // --- 9. Granting access --------------------------------------------------
  section('9. Access granted');
  let viewToken = '';
  {
    const student = await prisma.user.findUniqueOrThrow({ where: { email: STUDENT_EMAIL } });
    await prisma.entitlement.create({
      data: {
        userId: student.id,
        scope: 'SUBJECT',
        targetKey: `SUBJECT:${subject.id}`,
        subjectId: subject.id,
        grantedById: admin.id,
        source: 'ADMIN_GRANT',
      },
    });

    const allowed = await studentB.request(`/api/notes/${noteId}/view-token`, { method: 'POST' });
    const allowedBody = await body<{
      token?: string;
      contentUrl?: string;
      watermark?: { email?: string; sessionRef?: string };
    }>(allowed);

    check('the granted student can open the note', allowed.status === 200);
    check('a short-lived view token is issued', Boolean(allowedBody.token));
    check(
      'the watermark carries the reader’s own identity',
      allowedBody.watermark?.email === STUDENT_EMAIL,
      allowedBody.watermark?.email,
    );
    check('the watermark carries a session reference', Boolean(allowedBody.watermark?.sessionRef));

    viewToken = allowedBody.token ?? '';

    const content = await studentB.request(allowedBody.contentUrl ?? '');
    const bytes = Buffer.from(await content.arrayBuffer());
    check('the PDF bytes are served', content.status === 200);
    check('the response really is a PDF', bytes.subarray(0, 5).toString() === '%PDF-');
    check(
      'the content is marked as uncacheable',
      (content.headers.get('cache-control') ?? '').includes('no-store'),
      content.headers.get('cache-control') ?? 'missing',
    );
    check(
      'no permanent storage URL is exposed anywhere in the response',
      !JSON.stringify(allowedBody).includes('storageKey'),
    );

    // A token minted for one user must not work for another.
    const otherStudent = await prisma.user.create({
      data: {
        email: OTHER_EMAIL,
        name: 'Other Student',
        passwordHash: await bcrypt.hash(PASSWORD, 12),
        role: 'STUDENT',
      },
    });
    await prisma.entitlement.create({
      data: {
        userId: otherStudent.id,
        scope: 'SUBJECT',
        targetKey: `SUBJECT:${subject.id}`,
        subjectId: subject.id,
        source: 'ADMIN_GRANT',
      },
    });

    const otherClient = new Client('other');
    await otherClient.json('/api/auth/login', { email: OTHER_EMAIL, password: PASSWORD });
    const stolen = await otherClient.request(`/api/notes/${noteId}/content?t=${encodeURIComponent(viewToken)}`);
    check(
      'another student cannot reuse someone else’s view token',
      stolen.status === 403,
      `status ${stolen.status}`,
    );
  }

  // --- 10. Revocation ------------------------------------------------------
  section('10. Access revoked');
  {
    const student = await prisma.user.findUniqueOrThrow({ where: { email: STUDENT_EMAIL } });
    await prisma.entitlement.deleteMany({
      where: { userId: student.id, targetKey: `SUBJECT:${subject.id}` },
    });

    const remaining = await prisma.entitlement.count({
      where: { userId: student.id, targetKey: `SUBJECT:${subject.id}` },
    });
    check('the entitlement row is gone', remaining === 0);

    const afterRevoke = await studentB.request(`/api/notes/${noteId}/view-token`, { method: 'POST' });
    const withOldToken = await studentB.request(
      `/api/notes/${noteId}/content?t=${encodeURIComponent(viewToken)}`,
    );

    if (PREVIEW_MODE) {
      check(
        'open preview still lets them read (this is what the flag does)',
        afterRevoke.status === 200,
        `status ${afterRevoke.status}`,
      );
      console.log(
        '     \x1b[33mnote\x1b[0m revocation blocking is asserted with OPEN_ACCESS_MODE=false',
      );
    } else {
      check('the student can no longer open the note', afterRevoke.status === 404,
        `status ${afterRevoke.status}`);
      check(
        'an already-issued token stops working the moment access is revoked',
        withOldToken.status === 404 || withOldToken.status === 403,
        `status ${withOldToken.status}`,
      );
    }
  }

  // --- 11. Free notes ------------------------------------------------------
  section('11. Free visibility');
  {
    await prisma.note.update({ where: { id: noteId }, data: { visibility: 'FREE' } });
    const free = await studentB.request(`/api/notes/${noteId}/view-token`, { method: 'POST' });
    check('a note marked FREE opens for any signed-in student', free.status === 200);

    await prisma.note.update({
      where: { id: noteId },
      data: { visibility: 'RESTRICTED', status: 'DRAFT' },
    });
    const draft = await studentB.request(`/api/notes/${noteId}/view-token`, { method: 'POST' });
    check('a DRAFT note is never visible to students, in either mode', draft.status === 404);
    await prisma.note.update({ where: { id: noteId }, data: { status: 'PUBLISHED' } });
  }

  // --- 12. Suspension ------------------------------------------------------
  section('12. Account suspension');
  {
    const student = await prisma.user.findUniqueOrThrow({ where: { email: STUDENT_EMAIL } });
    await prisma.user.update({ where: { id: student.id }, data: { status: 'DISABLED' } });

    const heartbeat = await studentB.request('/api/session/heartbeat', { method: 'POST' });
    check('a disabled account loses its session at once', heartbeat.status === 401);

    const relogin = await new Client('suspended').json('/api/auth/login', {
      email: STUDENT_EMAIL,
      password: PASSWORD,
    });
    check('a disabled account cannot sign back in', relogin.status === 403);

    await prisma.user.update({ where: { id: student.id }, data: { status: 'ACTIVE' } });
  }

  // --- 13. Analytics -------------------------------------------------------
  section('13. Analytics');
  {
    const student = await prisma.user.findUniqueOrThrow({ where: { email: STUDENT_EMAIL } });

    const [logins, opens, registrations, sessions] = await Promise.all([
      prisma.activityEvent.count({ where: { type: 'LOGIN_SUCCESS', userId: student.id } }),
      prisma.activityEvent.count({ where: { type: 'NOTE_OPENED', userId: student.id } }),
      prisma.activityEvent.count({ where: { type: 'USER_REGISTERED', userId: student.id } }),
      prisma.activityEvent.count({ where: { type: 'SESSION_CREATED', userId: student.id } }),
    ]);

    check('logins are recorded', logins > 0, `${logins}`);
    check('note opens are recorded', opens > 0, `${opens}`);
    check('registration is recorded', registrations > 0, `${registrations}`);
    check('session creation is recorded', sessions > 0, `${sessions}`);

    const failedLogins = await prisma.activityEvent.count({ where: { type: 'LOGIN_FAILED' } });
    check('failed logins are recorded', failedLogins > 0, `${failedLogins}`);
  }

  // --- 14. Active user count -----------------------------------------------
  section('14. Active user count');
  {
    await adminClient.request('/api/session/heartbeat', { method: 'POST' });
    const response = await adminClient.request('/api/stats/live');
    const data = await body<{ liveUsers?: number }>(response);
    check('the live count endpoint responds', response.status === 200);
    check(
      'it reflects genuinely recent activity',
      typeof data.liveUsers === 'number' && data.liveUsers >= 1,
      `${data.liveUsers}`,
    );

    const anonymous = await new Client('anon3').request('/api/stats/live');
    check('the live count is not public', anonymous.status === 401);

    // Push one other live session outside the activity window and confirm it
    // drops out of the count - proving the number tracks real activity rather
    // than "how many people have ever signed in".
    const before = data.liveUsers ?? 0;
    await prisma.session.updateMany({
      where: { user: { email: OTHER_EMAIL }, status: 'ACTIVE' },
      data: { lastActivityAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const after = await body<{ liveUsers?: number }>(await adminClient.request('/api/stats/live'));
    check(
      'an idle session stops being counted as live',
      (after.liveUsers ?? 0) < before,
      `${before} -> ${after.liveUsers}`,
    );
  }


  // --- 15. Audit log -------------------------------------------------------
  section('15. Audit log');
  {
    const [uploads, adminLogins] = await Promise.all([
      prisma.auditLog.count({ where: { action: 'NOTE_UPLOADED', actorEmail: ADMIN_EMAIL } }),
      prisma.auditLog.count({ where: { action: 'ADMIN_LOGIN', actorEmail: ADMIN_EMAIL } }),
    ]);
    check('note uploads are audit logged', uploads > 0, `${uploads}`);
    check('admin sign-ins are audit logged', adminLogins > 0, `${adminLogins}`);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'NOTE_UPLOADED', actorEmail: ADMIN_EMAIL },
      orderBy: { createdAt: 'desc' },
    });
    check('the audit entry records who acted', entry?.actorEmail === ADMIN_EMAIL);
    check('the audit entry records the target', Boolean(entry?.targetId));
    check('the audit entry records the origin IP', Boolean(entry?.ipAddress));
  }

  // --- 16. Logout ----------------------------------------------------------
  section('16. Logout');
  {
    const response = await adminClient.request('/api/auth/logout', { method: 'POST' });
    check('logout succeeds', response.status === 200);

    const after = await adminClient.request('/api/session/heartbeat', { method: 'POST' });
    check('the session is dead afterwards', after.status === 401);

    const loggedOut = await prisma.session.count({
      where: { user: { email: ADMIN_EMAIL }, status: 'LOGGED_OUT' },
    });
    check('the logout is recorded on the session row', loggedOut > 0);
  }

  await finish();
}

async function finish() {
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
  await prisma.$disconnect();
  process.exit(1);
});
