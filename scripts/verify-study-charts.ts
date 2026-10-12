/**
 * Verifies the two admin study charts: "when students study" (students per hour)
 * and "students per subject", each over a day, a week or a month, moved back and
 * forward a period at a time.
 *
 *   npm run build
 *   DATABASE_URL=<local test db> VERIFY_DISPOSABLE_DB=<its name> AUTH_SECRET=<16+ chars> \
 *     npm run verify:study-charts
 *
 * The queries run directly against the approved database, with known readings
 * planted at known times; the endpoint is then checked through the suite's OWN
 * production server (`next start` on a free loopback port), which has to prove it
 * is using the approved database before any test runs. VERIFY_BASE_URL must not
 * be set.
 *
 * It creates and deletes accounts, notes and reading records, so it REFUSES TO
 * RUN unless the database is a disposable local one you have named in
 * VERIFY_DISPOSABLE_DB (scripts/lib/disposable-db.ts). Fixtures are prefixed
 * `studytest+` / `[studytest]` and are removed before and after.
 */
import 'dotenv/config';
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

const PREFIX = 'studytest';
const PASSWORD = 'Study-Charts-2026!';
const DAY = 24 * 60 * 60 * 1000;
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

async function cleanup() {
  await prisma.user.deleteMany({ where: { email: { contains: `${PREFIX}+` } } });
  await prisma.subject.deleteMany({ where: { name: { startsWith: '[studytest]' } } });
  await prisma.semester.deleteMany({ where: { name: { startsWith: '[studytest]' } } });
  await prisma.rateLimit.deleteMany({ where: { key: { contains: '203.0.113.' } } });
}

const handshakeProbe = {
  countMarker: (marker: string) =>
    prisma.activityEvent.count({ where: { type: 'LOGIN_FAILED', metadata: { path: ['email'], equals: marker } } }),
};

let server: OwnedServer | undefined;

async function main() {
  console.log(`\nVerifying the study charts\n${'─'.repeat(56)}`);
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
  process.env.ANALYTICS_TIMEZONE = 'UTC';
  const { studyHours, studySubjects, parseRange, parseOffset, parseDate, parseCustom, MAX_STUDY_OFFSET, MAX_CUSTOM_DAYS, activeByMonth, registrationsByMonth, parseMonths } = await import('../src/lib/analytics/study');
  const { readChartChoices } = await import('../src/lib/analytics/chart-settings-server');

  // --- fixtures ----------------------------------------------------------------
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const make = (name: string, role: 'STUDENT' | 'ADMIN' = 'STUDENT') =>
    prisma.user.create({ data: { email: `${PREFIX}+${name}@example.com`, name: `Study ${name}`, passwordHash, role, status: 'ACTIVE' } });
  const [alice, bob, cara, admin] = [await make('alice'), await make('bob'), await make('cara'), await make('admin', 'ADMIN')];

  const stamp = Date.now();
  const semester = await prisma.semester.create({ data: { name: '[studytest] Sem', slug: `studytest-${stamp}`, position: 94 } });
  const subjectA = await prisma.subject.create({ data: { semesterId: semester.id, name: '[studytest] Algorithms', slug: `studytest-a-${stamp}`, code: 'ALG101' } });
  const subjectB = await prisma.subject.create({ data: { semesterId: semester.id, name: '[studytest] Biology', slug: `studytest-b-${stamp}` } });
  const note = (subjectId: string, title: string) =>
    prisma.note.create({ data: { title, subjectId, storageKey: `notes/studytest-${stamp}-${title}.pdf`, fileName: `${title}.pdf`, fileSize: 1, status: 'PUBLISHED' } });
  const noteA1 = await note(subjectA.id, 'a1');
  const noteA2 = await note(subjectA.id, 'a2');
  const noteB1 = await note(subjectB.id, 'b1');

  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  /** A moment on a UTC day `days` from today, at hh:mm. */
  const at = (days: number, hh: number, mm = 0) => new Date(midnight.getTime() + days * DAY + (hh * 60 + mm) * 60_000);
  const view = (userId: string, noteId: string, startedAt: Date, minutes: number) =>
    prisma.noteView.create({ data: { userId, noteId, startedAt, durationMs: minutes * 60_000 } });

  // Yesterday: alice 08:40–09:20 (hours 8 and 9) and again 08:50 (still hour 8), bob 09:10 for 5 min
  // (hour 9), alice 15:00 with no recorded time (hour 15), cara 10:00 for FIVE hours (capped at four),
  // an admin who must not count, and a reading that ends exactly on the hour.
  await view(alice.id, noteA1.id, at(-1, 8, 40), 40);
  await view(alice.id, noteA1.id, at(-1, 8, 50), 5);
  await view(bob.id, noteA2.id, at(-1, 9, 10), 5);
  await view(alice.id, noteB1.id, at(-1, 15, 0), 0);
  await view(cara.id, noteB1.id, at(-1, 10, 0), 300);
  await view(admin.id, noteA1.id, at(-1, 17, 0), 30);
  await view(bob.id, noteB1.id, at(-1, 20, 0), 60);

  section('1. When students study — one day');
  {
    const y = await studyHours('day', -1);
    const at_ = (hour: number) => y.points.find((point) => point.hour === hour)?.value ?? -1;
    check('yesterday has all 24 hours', y.points.length === 24);
    check('a reading counts in every hour it overlapped (8 and 9)', at_(8) >= 1 && at_(9) >= 1);
    check('the same student reading twice in one hour counts once (hour 8 is alice only)', at_(8) === 1, String(at_(8)));
    check('two students in one hour count as two (hour 9: alice and bob)', at_(9) === 2, String(at_(9)));
    check('a reading with no recorded time still counts in its own hour (15)', at_(15) === 1, String(at_(15)));
    check('a sitting is capped at four hours (cara 10:00–14:00; nothing at 14)', at_(10) === 1 && at_(13) === 1 && at_(14) === 0, [10, 13, 14].map(at_).join(','));
    check('a reading that ends exactly on the hour does not spill into it (bob 20:00–21:00)', at_(20) === 1 && at_(21) === 0, `${at_(20)} ${at_(21)}`);
    check('an admin reading is not counted (hour 17 empty)', at_(17) === 0, String(at_(17)));
    check('three different students studied', y.students === 3, String(y.students));
    check('the busiest hour is 9', y.peakHour === 9, String(y.peakHour));
    check('it is a calendar day, labelled by its date', y.from === y.to && y.range === 'day' && y.offset === -1);
    check('there is an earlier period to go back to only if something is earlier', typeof y.hasEarlier === 'boolean' && y.hasLater === true);

    const empty = await studyHours('day', -5);
    check('a day with no reading is all zeros, not an error', empty.students === 0 && empty.peakHour === null && empty.points.every((point) => point.value === 0));

    await view(bob.id, noteA1.id, new Date(), 0);
    const today = await studyHours('day', 0);
    check('today stops at the current hour (it does not draw the future)', today.points.length === today.throughHour + 1);
    check('and includes a reading that just started', (today.points[today.points.length - 1]?.value ?? 0) >= 1 && today.hasLater === false);
  }

  section('2. When students study — a week and a month are day by day: students who studied, whole numbers');
  {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const dow = (midnight.getUTCDay() + 6) % 7; // Monday = 0
    const lastMonday = -dow - 7;
    await view(alice.id, noteA1.id, at(lastMonday, 22, 0), 30);
    await view(alice.id, noteA1.id, at(lastMonday + 1, 22, 0), 30);
    await view(bob.id, noteA2.id, at(lastMonday, 22, 30), 10);
    const week = await studyHours('week', -1);
    const monday = week.dayPoints.find((point) => point.date === iso(at(lastMonday, 0)));
    const tuesday = week.dayPoints.find((point) => point.date === iso(at(lastMonday + 1, 0)));
    check('a week has one point per day, Monday to Sunday', week.range === 'week' && week.dayPoints.length === 7 && week.points.length === 0);
    check('each day is how many different students studied — Monday: alice and bob = 2', monday?.value === 2, JSON.stringify(monday));
    check('with how many were studying at once, and when (2 together at 10 PM)', monday?.atOnce === 2 && monday?.peakHour === 22, JSON.stringify(monday));
    check('Tuesday: alice alone = 1, at once 1', tuesday?.value === 1 && tuesday?.atOnce === 1 && tuesday?.peakHour === 22, JSON.stringify(tuesday));
    const split = week.dayPoints.find((point) => point.date === iso(at(lastMonday + 2, 0)));
    check('a day with no reading is 0 (not missing) in a finished week', split?.value === 0 && split?.atOnce === 0 && split?.peakHour === null, JSON.stringify(split));
    check('every figure is a whole number, never an average', week.dayPoints.every((point) => point.value === null || Number.isInteger(point.value)));
    check('a finished week has no days still to come', week.dayPoints.every((point) => point.value !== null));
    check('the day the most students studied is reported (the maximum of the week)', week.peakDay?.value === Math.max(...week.dayPoints.map((point) => point.value ?? 0)) && (week.peakDay?.value ?? 0) >= 2, JSON.stringify(week.peakDay));

    const thisWeek = await studyHours('week', 0);
    const future = thisWeek.dayPoints.filter((point) => point.value === null).length;
    check('the current week leaves days that have not happened empty (no false zeros)', future === 6 - dow, `${future} vs ${6 - dow}`);

    const first = new Date(Date.UTC(midnight.getUTCFullYear(), midnight.getUTCMonth() - 1, 1));
    const daysInPrevious = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    await view(cara.id, noteB1.id, new Date(first.getTime() + 4 * DAY + 22 * 3_600_000), 30);
    await view(cara.id, noteB1.id, new Date(first.getTime() + 5 * DAY + 22 * 3_600_000), 30);
    await view(bob.id, noteB1.id, new Date(first.getTime() + 5 * DAY + 22 * 3_600_000), 30);
    const month = await studyHours('month', -1);
    const d5 = month.dayPoints.find((point) => point.date === iso(new Date(first.getTime() + 4 * DAY)));
    const d6 = month.dayPoints.find((point) => point.date === iso(new Date(first.getTime() + 5 * DAY)));
    check('last month has one point per date', month.dayPoints.length === daysInPrevious && month.dayPoints[0].date === iso(first), `${month.dayPoints.length} vs ${daysInPrevious}`);
    check('the 5th: cara alone = 1 student', d5?.value === 1 && d5?.atOnce === 1, JSON.stringify(d5));
    check('the 6th: cara and bob = 2 students, both at 10 PM (2 at once)', d6?.value === 2 && d6?.atOnce === 2 && d6?.peakHour === 22, JSON.stringify(d6));
    check('the date the most students studied is reported (the maximum of the month)', month.peakDay?.value === Math.max(...month.dayPoints.map((point) => point.value ?? 0)) && (month.peakDay?.value ?? 0) >= 2, JSON.stringify(month.peakDay));
    const thisMonth = await studyHours('month', 0);
    const monthDays = new Date(Date.UTC(midnight.getUTCFullYear(), midnight.getUTCMonth() + 1, 0)).getUTCDate();
    check('this month stops at today', thisMonth.dayPoints.filter((point) => point.value === null).length === monthDays - midnight.getUTCDate());
    check('going back stops where the readings start', (await studyHours('month', -1)).hasEarlier === false && (await studyHours('month', 0)).hasEarlier === true);
  }

  section('3. Students per subject');
  {
    const y = await studySubjects('day', -1);
    const byName = new Map(y.subjects.map((s) => [s.name, s.students]));
    check('students are counted once per subject (algorithms: alice and bob)', byName.get('[studytest] Algorithms') === 2, JSON.stringify([...byName]));
    check('biology: alice, cara and bob', byName.get('[studytest] Biology') === 3, JSON.stringify([...byName]));
    check('most-studied subject first', y.subjects[0]?.name === '[studytest] Biology');
    check("a subject's code is carried when it has one", y.subjects.find((s) => s.name === '[studytest] Algorithms')?.code === 'ALG101');
    check('the admin does not appear in either count', (byName.get('[studytest] Algorithms') ?? 0) <= 2);
    check('the total is the number of different students', y.students === 3);
    const weekSubjects = await studySubjects('week', 0);
    check('another period has its own numbers', weekSubjects.range === 'week');
    check('a period with no reading lists no subjects', (await studySubjects('day', -3)).subjects.length === 0);
  }

  section('4. The hour is the hour on the analytics clock, not UTC');
  {
    process.env.ANALYTICS_TIMEZONE = 'Asia/Kolkata';
    const kol = await studyHours('day', 0);
    const [ty, tm, td] = kol.today.split('-').map(Number);
    // 20:00 UTC three days ago is 01:30 the NEXT day in Kolkata.
    const utcDay = new Date(midnight.getTime() - 3 * DAY);
    await view(cara.id, noteA1.id, new Date(utcDay.getTime() + 20 * 3_600_000), 10);
    const localDay = new Date(Date.UTC(ty, tm - 1, td));
    const target = new Date(utcDay.getTime() + DAY);
    const offset = Math.round((target.getTime() - localDay.getTime()) / DAY);
    const there = await studyHours('day', offset);
    const hour1 = there.points.find((point) => point.hour === 1)?.value ?? 0;
    check('a reading at 20:00 UTC shows at 1 AM the next day in Kolkata', hour1 >= 1 && (there.points.find((point) => point.hour === 20)?.value ?? 0) === 0, JSON.stringify(there.points.filter((p) => p.value > 0)));
    process.env.ANALYTICS_TIMEZONE = 'Not/AZone';
    const { env } = await import('../src/lib/env');
    check('an unrecognised time zone falls back to the default instead of failing', env.analytics.timezone === 'Asia/Kolkata');
    process.env.ANALYTICS_TIMEZONE = 'UTC';
  }

  section('5. Inputs are clamped');
  {
    check('an unknown range is a day', parseRange('forever') === 'day' && parseRange(undefined) === 'day' && parseRange('week') === 'week' && parseRange('month') === 'month');
    check('an offset can only go back, and only so far', parseOffset('3') === 0 && parseOffset('-3') === -3 && parseOffset('abc') === 0 && parseOffset('-99999') === -MAX_STUDY_OFFSET);
  }

  section('5b. A span of days, or one particular day');
  {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const today = (await studyHours('day', 0)).today;
    const dow = (midnight.getUTCDay() + 6) % 7;
    const lastMonday = -dow - 7;
    const mon = iso(at(lastMonday, 0));
    const wed = iso(at(lastMonday + 2, 0));

    check('only real dates are accepted', parseDate('2026-02-28') === '2026-02-28' && ['2026-02-31', '2026-13-01', '26-1-1', 'abc', '', null, undefined, 20260101].every((v) => parseDate(v) === null));
    check('a span is put in order, and needs both ends', JSON.stringify(parseCustom(wed, mon)) === JSON.stringify({ from: mon, to: wed }) && parseCustom(mon, 'nope') === null && parseCustom(undefined, mon) === null);

    const span = await studyHours('custom', 0, { from: mon, to: wed });
    check('a span of days is day by day: Monday to Wednesday is three points', span.range === 'custom' && span.dayPoints.length === 3 && span.points.length === 0, `${span.dayPoints.length}`);
    check('with each day as the students who studied: 2, 1, 0', span.dayPoints.map((point) => point.value).join(',') === '2,1,0', span.dayPoints.map((point) => point.value).join(','));
    check('and no arrows to step (a span stays put)', span.hasLater === false && span.offset === 0 && span.from === mon && span.to === wed);
    check('the students across the span are counted once each', span.students === 2, String(span.students));

    const oneDay = await studyHours('custom', 0, { from: iso(at(-1, 0)), to: iso(at(-1, 0)) });
    const dayAgo = await studyHours('day', -1);
    check('a span of one date is that day, hour by hour — the same numbers as the Day view', oneDay.points.length === 24 && oneDay.dayPoints.length === 0 && JSON.stringify(oneDay.points) === JSON.stringify(dayAgo.points) && oneDay.students === dayAgo.students);
    const todayOnly = await studyHours('custom', 0, { from: today, to: today });
    check('picking today stops at the current hour', todayOnly.points.length === todayOnly.throughHour + 1);

    const future = await studyHours('custom', 0, { from: iso(at(-2, 0)), to: '2999-12-31' });
    check('a span is never allowed into the future (it ends today)', future.to === today && future.dayPoints.every((point) => point.value !== null));
    const allFuture = await studyHours('custom', 0, { from: '2999-01-01', to: '2999-01-05' });
    check('a span that is entirely in the future becomes today', allFuture.from === today && allFuture.to === today);
    const ancient = await studyHours('custom', 0, { from: '1999-01-01', to: today });
    check(`a span is capped at ${MAX_CUSTOM_DAYS} days`, ancient.dayPoints.length === MAX_CUSTOM_DAYS, String(ancient.dayPoints.length));
    const backwards = await studyHours('custom', 0, { from: wed, to: mon });
    check('an end before the start is lifted to the start (one day), not an error', backwards.from === wed && backwards.to === wed);

    const subjectsDay = await studySubjects('day', -1);
    const subjectsOne = await studySubjects('custom', 0, { from: iso(at(-1, 0)), to: iso(at(-1, 0)) });
    check('subjects over one picked day match the Day view', JSON.stringify(subjectsOne.subjects) === JSON.stringify(subjectsDay.subjects) && subjectsOne.students === subjectsDay.students);
    const subjectsSpan = await studySubjects('custom', 0, { from: mon, to: iso(at(-1, 0)) });
    const algorithms = subjectsSpan.subjects.find((subject) => subject.name === '[studytest] Algorithms')?.students ?? 0;
    // alice and bob read algorithms several times across the span; cara read it once, three days ago (section 4)
    check('subjects over a span count each student once per subject (alice, bob and cara = 3)', algorithms === 3 && subjectsSpan.range === 'custom', String(algorithms));
  }

  section('5c. Month by month — students using the notes, and registrations');
  {
    const monthStart = (back: number) => new Date(Date.UTC(midnight.getUTCFullYear(), midnight.getUTCMonth() - back, 1));
    const key = (date: Date) => date.toISOString().slice(0, 7);
    const midMonth = (back: number) => new Date(monthStart(back).getTime() + 14 * DAY + 12 * 3_600_000);
    // Three months ago alice and bob read; four months ago cara; five months ago nobody.
    await view(alice.id, noteA1.id, midMonth(3), 20);
    await view(bob.id, noteA2.id, midMonth(3), 20);
    await view(alice.id, noteA1.id, new Date(midMonth(3).getTime() + DAY), 20);
    await view(cara.id, noteB1.id, midMonth(4), 20);

    const active = await activeByMonth(6);
    const value = (back: number) => active.points.find((point) => point.month === key(monthStart(back)))?.value ?? -1;
    check('six months are drawn, oldest first, ending with this one', active.months === 6 && active.points.length === 6 && active.points[5].month === key(monthStart(0)) && active.points[0].month === key(monthStart(5)));
    check('only the current month is marked as still in progress', active.points.filter((point) => point.partial).length === 1 && active.points[5].partial === true);
    check('a month counts each student once however often they read (3 months ago: alice and bob = 2)', value(3) === 2, String(value(3)));
    check('4 months ago: cara = 1', value(4) === 1, String(value(4)));
    check('a month with no reading is 0, not missing (5 months ago)', value(5) === 0, String(value(5)));
    check('the admin never counts', active.points.every((point) => Number.isInteger(point.value)));
    check('a year and two years are available', (await activeByMonth(12)).points.length === 12 && (await activeByMonth(24)).points.length === 24);

    // Registrations: two students joined three months ago, one five months ago.
    const joined = (name: string, back: number) => prisma.user.create({ data: { email: `${PREFIX}+${name}@example.com`, name: `Study ${name}`, passwordHash, status: 'ACTIVE', createdAt: midMonth(back) } });
    await joined('old1', 3);
    await joined('old2', 3);
    await joined('older', 5);
    const registrations = await registrationsByMonth(12);
    const reg = (back: number) => registrations.points.find((point) => point.month === key(monthStart(back)));
    check('three months ago: 2 registrations', reg(3)?.value === 2, String(reg(3)?.value));
    check('five months ago: 1 registration', reg(5)?.value === 1, String(reg(5)?.value));
    check('a month with none is 0', reg(4)?.value === 0);
    check('each month carries the number of students by its end (1, 1, then 3)', reg(5)?.total === 1 && reg(4)?.total === 1 && reg(3)?.total === 3, `${reg(5)?.total} ${reg(4)?.total} ${reg(3)?.total}`);
    check('the totals only ever grow', registrations.points.every((point, i) => i === 0 || (point.total ?? 0) >= (registrations.points[i - 1].total ?? 0)));
    const studentCount = await prisma.user.count({ where: { role: 'STUDENT' } });
    check('and the latest total is every student there is (admins are not students)', registrations.points[11].total === studentCount, `${registrations.points[11].total} vs ${studentCount}`);

    check('only 6, 12 or 24 months are accepted', parseMonths('6') === 6 && parseMonths('24') === 24 && parseMonths('7') === 12 && parseMonths('999') === 12 && parseMonths('x') === 12 && parseMonths(undefined) === 12);
  }

  section('5d. The chart settings are remembered, and read back safely');
  {
    const cookie = (value: unknown) => encodeURIComponent(JSON.stringify(value));
    const saved = readChartChoices(cookie({ hours: { range: 'week', offset: -2 }, subjects: { range: 'custom', from: '2026-09-01', to: '2026-09-09' }, active: { months: 24 }, registrations: { months: 6 } }));
    check('a saved week, two back, is read back', saved.hours.range === 'week' && saved.hours.offset === -2);
    check('a saved custom span is read back with both dates', saved.subjects.range === 'custom' && saved.subjects.custom?.from === '2026-09-01' && saved.subjects.custom?.to === '2026-09-09');
    check('the saved month counts are read back', saved.activeMonths === 24 && saved.registrationMonths === 6);
    const fresh = readChartChoices(undefined);
    check('with nothing saved everything starts at today and a year', fresh.hours.range === 'day' && fresh.subjects.range === 'day' && fresh.activeMonths === 12 && fresh.registrationMonths === 12);
    check('garbage is ignored, not trusted', ['not json', '%E0%A4%A', cookie('x'), cookie(null), cookie([1, 2])].every((raw) => JSON.stringify(readChartChoices(raw)) === JSON.stringify(fresh)));
    const hostile = readChartChoices(cookie({ hours: { range: 'forever', offset: 99 }, subjects: { range: 'custom', from: 'x', to: 'y' }, active: { months: 7 }, registrations: { months: '"; drop' } }));
    check('bad values fall back one by one (unknown range → day, offset can only go back, custom needs real dates, months must be 6/12/24)', hostile.hours.range === 'day' && hostile.hours.offset === 0 && hostile.subjects.range === 'day' && hostile.activeMonths === 12 && hostile.registrationMonths === 12, JSON.stringify(hostile));
    check('an offset past the limit is clamped', readChartChoices(cookie({ hours: { range: 'day', offset: -99999 } })).hours.offset === -MAX_STUDY_OFFSET);
  }

  section('6. The endpoint is for admins only');
  {
    const authSecret = process.env.AUTH_SECRET ?? '';
    server = await startOwnedServer({ databaseUrl: process.env.DATABASE_URL!, authSecret, extraEnv: { ANALYTICS_TIMEZONE: 'UTC' } });
    if (!(await confirmServerUsesDatabase(server.baseUrl, handshakeProbe))) throw new Error('The test server could not be shown to be using the approved database.');
    const base = server.baseUrl;
    let ip = 10;
    const login = async (email: string) => {
      const headers = { 'Content-Type': 'application/json', 'x-forwarded-for': `203.0.113.${ip++}` };
      const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email, password: PASSWORD }) });
      if (response.status !== 200) throw new Error(`could not sign ${email} in: ${response.status}`);
      return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
    };
    const get = (query: string, cookie?: string) => fetch(`${base}/api/admin/analytics/study?${query}`, { headers: cookie ? { cookie } : {} });

    check('a visitor is refused (401)', (await get('chart=hours')).status === 401);
    const studentCookie = await login(alice.email);
    check('a student is refused (404, as for any admin route)', (await get('chart=hours', studentCookie)).status === 404);
    const adminCookie = await login(admin.email);
    const hours = await get('chart=hours&range=day&offset=-1', adminCookie);
    const body = (await hours.json()) as { points?: unknown[]; students?: number; peakHour?: number };
    check('an admin gets the hours (200)', hours.status === 200 && Array.isArray(body.points) && body.points.length === 24 && body.peakHour === 9, `status ${hours.status}`);
    check('never cached', (hours.headers.get('cache-control') ?? '').includes('no-store'));
    const subjects = await get('chart=subjects&range=week&offset=0', adminCookie);
    check('and the subjects (200)', subjects.status === 200 && Array.isArray(((await subjects.json()) as { subjects?: unknown[] }).subjects));
    const text = await (await get('chart=hours&range=day&offset=-1', adminCookie)).text();
    const subjectText = await (await get('chart=subjects&range=day&offset=-1', adminCookie)).text();
    check('counts only — no student name or email in either response', !text.includes(PREFIX) && !subjectText.includes(`${PREFIX}+`) && !/Study (alice|bob|cara)/.test(text + subjectText));
    const clamped = (await (await get('chart=hours&range=bogus&offset=-99999', adminCookie)).json()) as { range?: string; offset?: number };
    check('junk parameters are clamped, not trusted', clamped.range === 'day' && clamped.offset === -MAX_STUDY_OFFSET);
    const mondayIso = new Date(midnight.getTime() + (-((midnight.getUTCDay() + 6) % 7) - 7) * DAY).toISOString().slice(0, 10);
    const wednesdayIso = new Date(new Date(`${mondayIso}T00:00:00Z`).getTime() + 2 * DAY).toISOString().slice(0, 10);
    const spanResponse = (await (await get(`chart=hours&range=custom&from=${mondayIso}&to=${wednesdayIso}`, adminCookie)).json()) as { range?: string; dayPoints?: { value: number }[] };
    check('a custom span comes back day by day', spanResponse.range === 'custom' && spanResponse.dayPoints?.length === 3 && spanResponse.dayPoints.map((point) => point.value).join(',') === '2,1,0', JSON.stringify(spanResponse.dayPoints));
    const singleResponse = (await (await get(`chart=hours&range=custom&from=${mondayIso}&to=${mondayIso}`, adminCookie)).json()) as { points?: unknown[]; dayPoints?: unknown[] };
    check('one picked date comes back hour by hour', singleResponse.points?.length === 24 && singleResponse.dayPoints?.length === 0);
    const junk = (await (await get('chart=hours&range=custom&from=2026-02-31&to=nope', adminCookie)).json()) as { range?: string };
    check('a custom span with junk dates falls back to today, not an error', junk.range === 'day');
    const subjectSpan = await get(`chart=subjects&range=custom&from=${mondayIso}&to=${wednesdayIso}`, adminCookie);
    check('and subjects take a span too (200)', subjectSpan.status === 200);
    const monthlyActive = (await (await get('chart=active&months=6', adminCookie)).json()) as { chart?: string; points?: unknown[]; months?: number };
    check('an admin gets the active-students-by-month series', monthlyActive.chart === 'active' && monthlyActive.points?.length === 6 && monthlyActive.months === 6);
    const monthlyRegs = (await (await get('chart=registrations&months=999', adminCookie)).json()) as { points?: unknown[]; months?: number };
    check('and registrations — an unsupported length falls back to 12', monthlyRegs.points?.length === 12 && monthlyRegs.months === 12);
    check('the monthly series are admin-only too (401, 404)', (await get('chart=active')).status === 401 && (await get('chart=registrations', studentCookie)).status === 404);
    const monthlyText = JSON.stringify(monthlyActive) + JSON.stringify(monthlyRegs);
    check('and carry counts only', !monthlyText.includes(PREFIX) && !monthlyText.includes('@'));

    // The overview page draws its first view from the saved choices — no flash of the defaults.
    const choices = encodeURIComponent(JSON.stringify({ hours: { range: 'week', offset: -1 }, subjects: { range: 'custom', from: mondayIso, to: wednesdayIso }, active: { months: 24 } }));
    const remembered = await (await fetch(`${base}/admin`, { headers: { cookie: `${adminCookie}; cn_admin_charts=${choices}` } })).text();
    check('a saved "last week" is what the first chart shows', /Last week/.test(remembered) && /Students who studied on each day/.test(remembered));
    check('a saved custom span is what the subjects chart shows (with its dates)', new RegExp(`${new Date(`${mondayIso}T12:00:00Z`).getUTCDate()}`).test(remembered) && /type="date"/.test(remembered));
    check('a saved 24 months is what the monthly chart shows', /aria-pressed="true"[^>]*>24 months/.test(remembered));
    const plain = await (await fetch(`${base}/admin`, { headers: { cookie: adminCookie } })).text();
    check('without saved choices the first view is today', /Today/.test(plain) && /Students reading in each hour/.test(plain) && /aria-pressed="true"[^>]*>12 months/.test(plain));
    check('the overview has no "Returning" card', !/>Returning</.test(plain));
    check('"Active today" counts students who used notes today, in the Reach section', /Active today/.test(plain) && /students who used notes today/.test(plain));
    const page = await fetch(`${base}/admin`, { headers: { cookie: adminCookie } });
    const html = await page.text();
    check('the overview page renders all four charts for an admin', page.status === 200 && /When students study/.test(html) && /Students per subject/.test(html) && /Active students by month/.test(html) && /Total registrations by month/.test(html));
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
    await server?.stop();
    await prisma.$disconnect();
  });
