import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';

/**
 * "When do students study, and what" for the admin overview.
 *
 * Both charts read `note_views` — one row per time a student opened a note, with
 * how long they kept it open — for STUDENT accounts only. A student counts as
 * studying in every clock hour their reading overlapped: a note kept open from
 * 8:40 to 9:20 is 8 pm and 9 pm, not just the hour it was opened in. A single
 * sitting is capped at four hours so one forgotten tab cannot fill the night.
 *
 * Periods are calendar periods on the analytics clock (`ANALYTICS_TIMEZONE`): a
 * day, a Monday-to-Sunday week, or a month. `offset` moves back from the current
 * one — 0 is this day/week/month, -1 the one before.
 *
 * What the first chart shows depends on the period, and every figure is a plain
 * count of students, never an average:
 *   day    — students studying in each hour of that day;
 *   week   — for each day, how many different students studied that day;
 *   month  — the same, date by date.
 * For a week or month each day also carries how many were studying at once (in
 * its busiest hour) and when that was.
 *
 * `custom` is any span of days the admin picks (at most a year, never into the
 * future). A span of one day is that day hour by hour, exactly like `day`; a longer
 * one is day by day, like a week or month.
 */

export type StudyRange = 'day' | 'week' | 'month' | 'custom';

export const MAX_STUDY_OFFSET = 120;
const MAX_SITTING_MS = 4 * 60 * 60 * 1000;

export interface StudyWindow {
  range: StudyRange;
  offset: number;
  timezone: string;
  /** First and last day of the period, as YYYY-MM-DD on the analytics clock. */
  from: string;
  to: string;
  /** Today on the analytics clock, YYYY-MM-DD. */
  today: string;
  /** Days of the period that have happened so far (all of them for a past period). */
  days: number;
  hasEarlier: boolean;
  hasLater: boolean;
  /** For the current day: the last hour that has started, so the line does not run into the future. */
  throughHour: number;
}

export interface HourPoint {
  hour: number;
  /** Students studying in this hour. */
  value: number;
}

export interface DayPoint {
  /** The calendar day, YYYY-MM-DD on the analytics clock. */
  date: string;
  /** Different students who studied that day — how many used the platform. Null for a day that has not happened yet. */
  value: number | null;
  /** The most students studying at once — in the busiest hour of the day. */
  atOnce: number;
  /** The hour that was busiest, or null when nobody studied. */
  peakHour: number | null;
}

export interface SubjectPoint {
  id: string;
  name: string;
  code: string | null;
  students: number;
}

export interface HoursResult extends StudyWindow {
  /** A day: one point per hour. Empty for a week or month. */
  points: HourPoint[];
  /** A week or month: one point per day. Empty for a day. */
  dayPoints: DayPoint[];
  /** Different students who studied at all in the period. */
  students: number;
  /** A day: the busiest hour, or null when nobody studied. */
  peakHour: number | null;
  /** A week or month: the day the most students studied, or null when nobody did. */
  peakDay: DayPoint | null;
}

export interface SubjectsResult extends StudyWindow {
  subjects: SubjectPoint[];
  students: number;
}

export const MAX_CUSTOM_DAYS = 366;

export interface CustomSpan {
  from: string;
  to: string;
}

export function parseRange(value: unknown): StudyRange {
  return value === 'week' || value === 'month' || value === 'custom' ? value : 'day';
}

/** A YYYY-MM-DD calendar date, or null for anything else (including 2026-02-31). */
export function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

/** Both ends of a custom span, put in order; null if either is not a real date. */
export function parseCustom(from: unknown, to: unknown): CustomSpan | null {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

export function parseOffset(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-MAX_STUDY_OFFSET, Math.min(0, parsed));
}

/**
 * SQL for where a period starts and ends, on the analytics clock (timestamps
 * without a time zone). The calendar periods are computed from "now"; a custom
 * span is clamped here, in SQL, against today on the analytics clock — it never
 * reaches into the future, never starts before today minus a year, and an end
 * before its start is lifted to the start. The dates reach SQL only as bound
 * parameters that `parseDate` has already validated.
 */
function bounds(
  range: StudyRange,
  offset: number,
  custom: CustomSpan | null,
  tz: string,
): { start: Prisma.Sql; end: Prisma.Sql } {
  const nowLocal = Prisma.sql`(now() AT TIME ZONE ${tz}::text)`;

  if (range === 'custom' && custom) {
    const today = Prisma.sql`(date_trunc('day', ${nowLocal}))::date`;
    const startDay = Prisma.sql`GREATEST(LEAST(${custom.from}::date, ${today}), ${today} - ${MAX_CUSTOM_DAYS - 1}::int)`;
    const endDay = Prisma.sql`GREATEST(LEAST(${custom.to}::date, ${today}), ${startDay})`;
    return { start: Prisma.sql`(${startDay})::timestamp`, end: Prisma.sql`((${endDay}) + 1)::timestamp` };
  }

  switch (range) {
    case 'week': {
      const start = Prisma.sql`date_trunc('week', ${nowLocal}) + make_interval(days => ${offset * 7}::int)`;
      return { start, end: Prisma.sql`(${start}) + interval '7 days'` };
    }
    case 'month': {
      const start = Prisma.sql`date_trunc('month', ${nowLocal}) + make_interval(months => ${offset}::int)`;
      return { start, end: Prisma.sql`(${start}) + interval '1 month'` };
    }
    default: {
      const start = Prisma.sql`date_trunc('day', ${nowLocal}) + make_interval(days => ${offset}::int)`;
      return { start, end: Prisma.sql`(${start}) + interval '1 day'` };
    }
  }
}

interface WindowRow {
  from: string;
  to: string;
  today: string;
  days: number;
  has_earlier: boolean;
  through_hour: number;
}

async function readWindow(range: StudyRange, offset: number, custom: CustomSpan | null): Promise<StudyWindow> {
  const tz = env.analytics.timezone;
  const { start, end } = bounds(range, offset, custom, tz);
  const [row] = await prisma.$queryRaw<WindowRow[]>`
    WITH p AS (
      SELECT ${start} AS s, ${end} AS e,
             date_trunc('day', now() AT TIME ZONE ${tz}::text) AS t
    )
    SELECT to_char(p.s, 'YYYY-MM-DD') AS "from",
           to_char(p.e - interval '1 day', 'YYYY-MM-DD') AS "to",
           to_char(p.t, 'YYYY-MM-DD') AS "today",
           GREATEST(1, LEAST(
             (p.e::date - p.s::date),
             (p.t::date + 1 - p.s::date)
           ))::int AS days,
           EXISTS (
             SELECT 1 FROM note_views v
             WHERE ((v."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text) < p.s
           ) AS has_earlier,
           EXTRACT(HOUR FROM (now() AT TIME ZONE ${tz}::text))::int AS through_hour
    FROM p
  `;
  return {
    range,
    offset: range === 'custom' ? 0 : offset,
    timezone: tz,
    from: row.from,
    to: row.to,
    today: row.today,
    days: row.days,
    hasEarlier: row.has_earlier,
    hasLater: range !== 'custom' && offset < 0,
    throughHour: row.through_hour,
  };
}

/** The readings in the window, on the analytics clock. Used by both charts. */
function readingsIn(range: StudyRange, offset: number, custom: CustomSpan | null, tz: string): Prisma.Sql {
  const { start, end } = bounds(range, offset, custom, tz);
  return Prisma.sql`
    SELECT v."userId", v."noteId",
           ((v."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text) AS s,
           ((v."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)
             + (LEAST(GREATEST(v."durationMs", 0), ${MAX_SITTING_MS}::int) * interval '1 millisecond') AS e
    FROM note_views v
    JOIN users u ON u.id = v."userId" AND u.role = 'STUDENT'
    WHERE v."startedAt" >= (now() - interval '400 days')
      AND ((v."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text) >= ${start}
      AND ((v."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text) < ${end}
  `;
}

export async function studyHours(range: StudyRange, offset: number, custom: CustomSpan | null = null): Promise<HoursResult> {
  const window = await readWindow(range, offset, custom);
  const tz = window.timezone;

  // One row per (student, clock hour) — a student reading across a whole hour, or
  // several notes in it, is one student in that hour.
  const spans = Prisma.sql`
    WITH reads AS (${readingsIn(range, offset, custom, tz)}),
    spans AS (
      SELECT DISTINCT r."userId", gs AS hour_ts
      FROM reads r,
           generate_series(
             date_trunc('hour', r.s),
             -- the last hour is the one the reading ENDED in; a sitting that ends exactly
             -- on the hour did not spill into it
             date_trunc('hour', GREATEST(r.s, r.e - interval '1 millisecond')),
             interval '1 hour'
           ) AS gs
    )`;

  const [{ students }] = await prisma.$queryRaw<{ students: number }[]>`
    WITH reads AS (${readingsIn(range, offset, custom, tz)})
    SELECT COUNT(DISTINCT "userId")::int AS students FROM reads
  `;

  // One day — a `day`, or a custom span of a single date — is shown hour by hour.
  if (window.from === window.to) {
    const rows = await prisma.$queryRaw<{ hour: number; students: number }[]>`
      ${spans}
      SELECT EXTRACT(HOUR FROM hour_ts)::int AS hour, COUNT(*)::int AS students
      FROM spans
      GROUP BY 1
    `;
    const byHour = new Map(rows.map((row) => [row.hour, row.students]));
    const last = window.from === window.today ? window.throughHour : 23;
    const points: HourPoint[] = [];
    for (let hour = 0; hour <= last; hour += 1) points.push({ hour, value: byHour.get(hour) ?? 0 });
    const peak = points.reduce<HourPoint | null>(
      (best, point) => (point.value > 0 && (!best || point.value > best.value) ? point : best),
      null,
    );
    return { ...window, points, dayPoints: [], students, peakHour: peak ? peak.hour : null, peakDay: null };
  }

  // A week or month: for each day, how many students studied, and the busiest hour in it.
  const rows = await prisma.$queryRaw<{ date: string; peak: number; peak_hour: number; students: number }[]>`
    ${spans},
    per_hour AS (
      SELECT date_trunc('day', hour_ts) AS d, EXTRACT(HOUR FROM hour_ts)::int AS h, COUNT(*)::int AS n
      FROM spans
      GROUP BY 1, 2
    ),
    busiest AS (
      SELECT DISTINCT ON (d) d, h, n FROM per_hour ORDER BY d, n DESC, h ASC
    ),
    per_day AS (
      SELECT date_trunc('day', hour_ts) AS d, COUNT(DISTINCT "userId")::int AS students
      FROM spans
      GROUP BY 1
    )
    SELECT to_char(b.d, 'YYYY-MM-DD') AS date, b.n AS peak, b.h AS peak_hour, p.students
    FROM busiest b JOIN per_day p ON p.d = b.d
  `;
  const byDate = new Map(rows.map((row) => [row.date, row]));

  const dayPoints: DayPoint[] = [];
  const end = new Date(`${window.to}T12:00:00Z`).getTime();
  for (let t = new Date(`${window.from}T12:00:00Z`).getTime(); t <= end; t += 24 * 60 * 60 * 1000) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (date > window.today) {
      dayPoints.push({ date, value: null, atOnce: 0, peakHour: null });
      continue;
    }
    const row = byDate.get(date);
    dayPoints.push({ date, value: row?.students ?? 0, atOnce: row?.peak ?? 0, peakHour: row?.peak_hour ?? null });
  }
  const peakDay = dayPoints.reduce<DayPoint | null>(
    (best, point) => ((point.value ?? 0) > 0 && (!best || (point.value ?? 0) > (best.value ?? 0)) ? point : best),
    null,
  );
  return { ...window, points: [], dayPoints, students, peakHour: null, peakDay };
}

export async function studySubjects(range: StudyRange, offset: number, custom: CustomSpan | null = null): Promise<SubjectsResult> {
  const window = await readWindow(range, offset, custom);
  const tz = window.timezone;

  const subjects = await prisma.$queryRaw<SubjectPoint[]>`
    WITH reads AS (${readingsIn(range, offset, custom, tz)})
    SELECT s.id, s.name, s.code, COUNT(DISTINCT r."userId")::int AS students
    FROM reads r
    JOIN notes n ON n.id = r."noteId"
    JOIN subjects s ON s.id = n."subjectId"
    GROUP BY s.id, s.name, s.code
    ORDER BY students DESC, s.name ASC
    LIMIT 12
  `;
  const [{ students }] = await prisma.$queryRaw<{ students: number }[]>`
    WITH reads AS (${readingsIn(range, offset, custom, tz)})
    SELECT COUNT(DISTINCT "userId")::int AS students FROM reads
  `;
  return { ...window, subjects, students };
}

// ---------------------------------------------------------------------------
// Month by month: how many students are using the notes, and how many join
// ---------------------------------------------------------------------------

export const MONTH_CHOICES = [6, 12, 24] as const;

export function parseMonths(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return (MONTH_CHOICES as readonly number[]).includes(parsed) ? parsed : 12;
}

export interface MonthPoint {
  /** The calendar month, YYYY-MM on the analytics clock. */
  month: string;
  value: number;
  /** Registrations only: all students registered by the end of the month. */
  total: number | null;
  /** The month has not finished — it is counted so far. */
  partial: boolean;
}

export interface MonthlyResult {
  chart: 'active' | 'registrations';
  months: number;
  timezone: string;
  points: MonthPoint[];
}

/** The months on the analytics clock, oldest first, ending with the current one. */
function monthSeries(months: number, tz: string): Prisma.Sql {
  const thisMonth = Prisma.sql`date_trunc('month', now() AT TIME ZONE ${tz}::text)`;
  return Prisma.sql`
    SELECT generate_series(
             ${thisMonth} - make_interval(months => ${months - 1}::int),
             ${thisMonth},
             interval '1 month'
           ) AS month`;
}

/**
 * Students who used the notes in each month — different students who opened at
 * least one note in it. The line across months is growth (or loss) in the people
 * actually reading, not in accounts. The current month is partial.
 */
export async function activeByMonth(months: number): Promise<MonthlyResult> {
  const tz = env.analytics.timezone;
  const rows = await prisma.$queryRaw<{ month: string; value: number; partial: boolean }[]>`
    WITH m AS (${monthSeries(months, tz)}),
    active AS (
      SELECT date_trunc('month', (v."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text) AS month,
             COUNT(DISTINCT v."userId")::int AS n
      FROM note_views v
      JOIN users u ON u.id = v."userId" AND u.role = 'STUDENT'
      WHERE v."startedAt" >= now() - make_interval(months => ${months + 1}::int)
      GROUP BY 1
    )
    SELECT to_char(m.month, 'YYYY-MM') AS month,
           COALESCE(a.n, 0)::int AS value,
           (m.month = date_trunc('month', now() AT TIME ZONE ${tz}::text)) AS partial
    FROM m LEFT JOIN active a ON a.month = m.month
    ORDER BY m.month
  `;
  return {
    chart: 'active',
    months,
    timezone: tz,
    points: rows.map((row) => ({ month: row.month, value: row.value, total: null, partial: row.partial })),
  };
}

/** New student accounts in each month, with how many students there were by its end. */
export async function registrationsByMonth(months: number): Promise<MonthlyResult> {
  const tz = env.analytics.timezone;
  const rows = await prisma.$queryRaw<{ month: string; value: number; total: number; partial: boolean }[]>`
    WITH m AS (${monthSeries(months, tz)}),
    joined AS (
      SELECT date_trunc('month', (u."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text) AS month,
             COUNT(*)::int AS n
      FROM users u
      WHERE u.role = 'STUDENT' AND u."createdAt" >= now() - make_interval(months => ${months + 1}::int)
      GROUP BY 1
    )
    SELECT to_char(m.month, 'YYYY-MM') AS month,
           COALESCE(j.n, 0)::int AS value,
           (SELECT COUNT(*)::int FROM users u
              WHERE u.role = 'STUDENT'
                AND ((u."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text) < m.month + interval '1 month') AS total,
           (m.month = date_trunc('month', now() AT TIME ZONE ${tz}::text)) AS partial
    FROM m LEFT JOIN joined j ON j.month = m.month
    ORDER BY m.month
  `;
  return {
    chart: 'registrations',
    months,
    timezone: tz,
    points: rows.map((row) => ({ month: row.month, value: row.value, total: row.total, partial: row.partial })),
  };
}
