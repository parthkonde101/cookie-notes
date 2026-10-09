import 'server-only';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { liveCutoff } from '@/lib/auth/session';
import { PAGE_VIEW_EVENT } from '@/lib/analytics/events';

/**
 * Every figure the dashboards show comes from one of these queries. There is no
 * seeded, sampled or estimated number anywhere in the analytics surface — if the
 * database has nothing to say, the UI renders an empty state instead.
 */

function startOfDay(date = new Date()): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Admin overview cards
// ---------------------------------------------------------------------------

export async function adminOverview() {
  const today = startOfDay();
  const weekAgo = daysAgo(7);
  const monthAgo = daysAgo(30);

  const [
    totalUsers,
    activeUsers,
    disabledUsers,
    newToday,
    newThisWeek,
    totalNotes,
    publishedNotes,
    totalSubjects,
    viewsToday,
    totalViews,
    liveSessions,
    dau,
    wau,
    mau,
    verifiedStudents,
    readersToday,
    readersEver,
    returningStudents,
    readingTime,
    reminders,
    feedbackCount,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'STUDENT' } }),
    prisma.user.count({ where: { role: 'STUDENT', status: 'ACTIVE' } }),
    prisma.user.count({ where: { role: 'STUDENT', status: 'DISABLED' } }),
    prisma.user.count({ where: { role: 'STUDENT', createdAt: { gte: today } } }),
    prisma.user.count({ where: { role: 'STUDENT', createdAt: { gte: weekAgo } } }),
    prisma.note.count(),
    prisma.note.count({ where: { status: 'PUBLISHED' } }),
    prisma.subject.count({ where: { isArchived: false } }),
    prisma.activityEvent.count({ where: { type: 'NOTE_OPENED', createdAt: { gte: today } } }),
    prisma.activityEvent.count({ where: { type: 'NOTE_OPENED' } }),
    prisma.session.count({
      where: { status: 'ACTIVE', lastActivityAt: { gt: liveCutoff() }, expiresAt: { gt: new Date() } },
    }),
    distinctActiveUsers(today),
    distinctActiveUsers(weekAgo),
    distinctActiveUsers(monthAgo),
    prisma.user.count({ where: { role: 'STUDENT', emailVerifiedAt: { not: null } } }),
    distinctStudentReaders(today),
    distinctStudentReaders(null),
    returningStudentsSince(weekAgo),
    prisma.$queryRaw<{ avg_ms: number | null }[]>`
      SELECT AVG("durationMs")::float AS avg_ms FROM note_views WHERE "durationMs" > 0
    `,
    prisma.unitNotificationSubscription.count(),
    prisma.feedback.count(),
  ]);

  const [mostViewedNote, mostActiveUsers] = await Promise.all([
    prisma.note.findFirst({
      where: { viewCount: { gt: 0 } },
      orderBy: { viewCount: 'desc' },
      select: { id: true, title: true, viewCount: true, subject: { select: { name: true } } },
    }),
    topActiveUsers(5),
  ]);

  return {
    totalUsers,
    activeUsers,
    disabledUsers,
    newToday,
    newThisWeek,
    totalNotes,
    publishedNotes,
    totalSubjects,
    viewsToday,
    totalViews,
    liveSessions,
    dau,
    wau,
    mau,
    verifiedStudents,
    readersToday,
    /** Students who have opened at least one note, ever. */
    readersEver,
    /** Students who came back on a second day within the last week. */
    returningStudents,
    averageReadMs: Math.round(readingTime[0]?.avg_ms ?? 0),
    /** "Notify me" requests on units still being baked — unmet demand. */
    reminders,
    feedbackCount,
    mostViewedNote,
    mostActiveUsers,
    liveWindowMinutes: env.liveWindowMinutes,
  };
}

/** Distinct students who opened a note — since a date, or ever when null. */
async function distinctStudentReaders(since: Date | null): Promise<number> {
  const rows = await prisma.activityEvent.findMany({
    where: {
      type: 'NOTE_OPENED',
      user: { role: 'STUDENT' },
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  return rows.length;
}

/** Students active on at least two different days since a date. */
async function returningStudentsSince(since: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM (
      SELECT e."userId"
      FROM activity_events e
      JOIN users u ON u.id = e."userId" AND u.role = 'STUDENT'
      WHERE e."createdAt" >= ${since}
      GROUP BY e."userId"
      HAVING COUNT(DISTINCT date_trunc('day', e."createdAt")) >= 2
    ) AS multi_day
  `;
  return rows[0]?.count ?? 0;
}

async function distinctActiveUsers(since: Date): Promise<number> {
  const rows = await prisma.activityEvent.findMany({
    where: { createdAt: { gte: since }, userId: { not: null } },
    select: { userId: true },
    distinct: ['userId'],
  });
  return rows.length;
}

export async function topActiveUsers(limit = 10) {
  const rows = await prisma.$queryRaw<
    { id: string; name: string; email: string; events: number; last_seen: Date | null }[]
  >`
    SELECT u.id, u.name, u.email, COUNT(e.id)::int AS events, MAX(e."createdAt") AS last_seen
    FROM users u
    JOIN activity_events e ON e."userId" = u.id
    WHERE u.role = 'STUDENT' AND e."createdAt" >= NOW() - INTERVAL '30 days'
    GROUP BY u.id, u.name, u.email
    ORDER BY events DESC
    LIMIT ${limit}
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  date: string;
  value: number;
}

/**
 * A dense daily series (missing days appear as zero) so charts do not lie by
 * skipping quiet days.
 */
async function dailySeries(
  table: 'users' | 'activity_events',
  options: { days: number; eventType?: string; distinctUsers?: boolean },
): Promise<SeriesPoint[]> {
  const { days } = options;

  if (table === 'users') {
    return prisma.$queryRaw<SeriesPoint[]>`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
             COALESCE(COUNT(u.id), 0)::int AS value
      FROM generate_series(
             (CURRENT_DATE - (${days - 1}::int) * INTERVAL '1 day')::date,
             CURRENT_DATE,
             INTERVAL '1 day'
           ) AS d(day)
      LEFT JOIN users u
        ON u."createdAt" >= d.day
       AND u."createdAt" < d.day + INTERVAL '1 day'
       AND u.role = 'STUDENT'
      GROUP BY d.day
      ORDER BY d.day
    `;
  }

  if (options.distinctUsers) {
    return prisma.$queryRaw<SeriesPoint[]>`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
             COALESCE(COUNT(DISTINCT e."userId"), 0)::int AS value
      FROM generate_series(
             (CURRENT_DATE - (${days - 1}::int) * INTERVAL '1 day')::date,
             CURRENT_DATE,
             INTERVAL '1 day'
           ) AS d(day)
      LEFT JOIN activity_events e
        ON e."createdAt" >= d.day
       AND e."createdAt" < d.day + INTERVAL '1 day'
      GROUP BY d.day
      ORDER BY d.day
    `;
  }

  return prisma.$queryRaw<SeriesPoint[]>`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
           COALESCE(COUNT(e.id), 0)::int AS value
    FROM generate_series(
           (CURRENT_DATE - (${days - 1}::int) * INTERVAL '1 day')::date,
           CURRENT_DATE,
           INTERVAL '1 day'
         ) AS d(day)
    LEFT JOIN activity_events e
      ON e."createdAt" >= d.day
     AND e."createdAt" < d.day + INTERVAL '1 day'
     AND e.type = ${options.eventType}::"EventType"
    GROUP BY d.day
    ORDER BY d.day
  `;
}

export async function growthSeries(days = 30) {
  const [registrations, activeUsers, noteViews, logins] = await Promise.all([
    dailySeries('users', { days }),
    dailySeries('activity_events', { days, distinctUsers: true }),
    dailySeries('activity_events', { days, eventType: 'NOTE_OPENED' }),
    dailySeries('activity_events', { days, eventType: 'LOGIN_SUCCESS' }),
  ]);
  return { registrations, activeUsers, noteViews, logins };
}

// ---------------------------------------------------------------------------
// Content analytics
// ---------------------------------------------------------------------------

export async function contentAnalytics() {
  const [mostViewed, leastViewed, topSubjects, durations, recentlyAccessed] = await Promise.all([
    prisma.note.findMany({
      where: { viewCount: { gt: 0 } },
      orderBy: { viewCount: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        viewCount: true,
        subject: { select: { name: true } },
      },
    }),

    prisma.note.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: [{ viewCount: 'asc' }, { createdAt: 'asc' }],
      take: 10,
      select: {
        id: true,
        title: true,
        viewCount: true,
        createdAt: true,
        subject: { select: { name: true } },
      },
    }),

    prisma.$queryRaw<{ id: string; name: string; views: number; notes: number }[]>`
      SELECT s.id, s.name,
             COALESCE(SUM(n."viewCount"), 0)::int AS views,
             COUNT(n.id)::int AS notes
      FROM subjects s
      LEFT JOIN notes n ON n."subjectId" = s.id
      GROUP BY s.id, s.name
      HAVING COUNT(n.id) > 0
      ORDER BY views DESC
      LIMIT 8
    `,

    prisma.$queryRaw<{ avg_ms: number | null; total_sessions: number; total_ms: number | null }[]>`
      SELECT AVG("durationMs")::float AS avg_ms,
             COUNT(*)::int AS total_sessions,
             SUM("durationMs")::float AS total_ms
      FROM note_views
      WHERE "durationMs" > 0
    `,

    prisma.noteView.findMany({
      orderBy: { startedAt: 'desc' },
      take: 12,
      select: {
        id: true,
        startedAt: true,
        durationMs: true,
        maxPage: true,
        note: { select: { id: true, title: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  const duration = durations[0] ?? { avg_ms: 0, total_sessions: 0, total_ms: 0 };

  return {
    mostViewed,
    leastViewed,
    topSubjects,
    averageDurationMs: Math.round(duration.avg_ms ?? 0),
    readingSessions: duration.total_sessions ?? 0,
    totalReadingMs: Math.round(duration.total_ms ?? 0),
    recentlyAccessed,
  };
}

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

export async function engagementAnalytics() {
  const today = startOfDay();
  const weekAgo = daysAgo(7);

  const [sessionStats, returningUsers, activeToday, activeThisWeek, loginsPerUser] =
    await Promise.all([
      prisma.$queryRaw<{ avg_seconds: number | null; total: number }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("lastActivityAt" - "createdAt")))::float AS avg_seconds,
               COUNT(*)::int AS total
        FROM sessions
        WHERE "lastActivityAt" > "createdAt"
      `,

      prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM (
          SELECT "userId"
          FROM activity_events
          WHERE type = 'LOGIN_SUCCESS'
          GROUP BY "userId"
          HAVING COUNT(*) > 1
        ) AS repeat_logins
      `,

      distinctActiveUsers(today),
      distinctActiveUsers(weekAgo),

      prisma.$queryRaw<{ avg_logins: number | null }[]>`
        SELECT AVG(login_count)::float AS avg_logins FROM (
          SELECT "userId", COUNT(*)::int AS login_count
          FROM activity_events
          WHERE type = 'LOGIN_SUCCESS' AND "userId" IS NOT NULL
          GROUP BY "userId"
        ) AS per_user
      `,
    ]);

  const totalSessions = await prisma.session.count();
  const totalStudents = await prisma.user.count({ where: { role: 'STUDENT' } });

  return {
    averageSessionSeconds: Math.round(sessionStats[0]?.avg_seconds ?? 0),
    returningUsers: returningUsers[0]?.count ?? 0,
    activeToday,
    activeThisWeek,
    averageLoginsPerUser: Number((loginsPerUser[0]?.avg_logins ?? 0).toFixed(1)),
    averageSessionsPerUser:
      totalStudents > 0 ? Number((totalSessions / totalStudents).toFixed(1)) : 0,
  };
}

// ---------------------------------------------------------------------------
// Reach: which pages and which programmes students use
// ---------------------------------------------------------------------------

export type ProgramKey = 'BTECH' | 'POLYTECHNIC';

export interface PageViewStats {
  page: 'home' | 'about';
  /** Distinct signed-in students in the window. */
  students: number;
  /** All views in the window by signed-in students. */
  studentViews: number;
  /** Views in the window by visitors who were not signed in. */
  visitorViews: number;
  studentsAllTime: number;
  viewsAllTime: number;
  /** When counting began, or null while nothing has been recorded. */
  since: Date | null;
  series: SeriesPoint[];
}

/**
 * Views of the Home and About pages. Admin views are left out; a signed-out
 * visitor counts as a view but not as a student.
 */
export async function pageViewAnalytics(days: number): Promise<PageViewStats[]> {
  const rows = await prisma.$queryRaw<
    {
      page: string;
      students: number;
      student_views: number;
      visitor_views: number;
      students_all: number;
      views_all: number;
      first_at: Date | null;
    }[]
  >`
    SELECT e.metadata->>'page' AS page,
           COUNT(DISTINCT e."userId") FILTER (
             WHERE e."createdAt" >= NOW() - (${days}::int * INTERVAL '1 day'))::int AS students,
           COUNT(*) FILTER (
             WHERE e."userId" IS NOT NULL
               AND e."createdAt" >= NOW() - (${days}::int * INTERVAL '1 day'))::int AS student_views,
           COUNT(*) FILTER (
             WHERE e."userId" IS NULL
               AND e."createdAt" >= NOW() - (${days}::int * INTERVAL '1 day'))::int AS visitor_views,
           COUNT(DISTINCT e."userId")::int AS students_all,
           COUNT(*)::int AS views_all,
           MIN(e."createdAt") AS first_at
    FROM activity_events e
    LEFT JOIN users u ON u.id = e."userId"
    WHERE e.type = ${PAGE_VIEW_EVENT}::"EventType"
      AND e.metadata->>'page' IN ('home', 'about')
      AND (e."userId" IS NULL OR u.role = 'STUDENT')
    GROUP BY e.metadata->>'page'
  `;

  const series = await Promise.all(
    (['home', 'about'] as const).map((page) =>
      prisma.$queryRaw<SeriesPoint[]>`
        SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
               COALESCE(COUNT(v.id), 0)::int AS value
        FROM generate_series(
               (CURRENT_DATE - (${days - 1}::int) * INTERVAL '1 day')::date,
               CURRENT_DATE,
               INTERVAL '1 day'
             ) AS d(day)
        LEFT JOIN (
          SELECT e.id, e."createdAt"
          FROM activity_events e
          LEFT JOIN users u ON u.id = e."userId"
          WHERE e.type = ${PAGE_VIEW_EVENT}::"EventType"
            AND e.metadata->>'page' = ${page}
            AND (e."userId" IS NULL OR u.role = 'STUDENT')
        ) v
          ON v."createdAt" >= d.day AND v."createdAt" < d.day + INTERVAL '1 day'
        GROUP BY d.day
        ORDER BY d.day
      `,
    ),
  );

  return (['home', 'about'] as const).map((page, index) => {
    const row = rows.find((candidate) => candidate.page === page);
    return {
      page,
      students: row?.students ?? 0,
      studentViews: row?.student_views ?? 0,
      visitorViews: row?.visitor_views ?? 0,
      studentsAllTime: row?.students_all ?? 0,
      viewsAllTime: row?.views_all ?? 0,
      since: row?.first_at ?? null,
      series: series[index],
    };
  });
}

export interface ProgramStats {
  program: ProgramKey;
  /** Distinct students who opened a note in the window. */
  students: number;
  noteOpens: number;
  paperOpens: number;
  catalogueViews: number;
  studentsAllTime: number;
  noteOpensAllTime: number;
  publishedNotes: number;
}

/**
 * How many students use the B.Tech and Polytechnic notes. A note belongs to a
 * subject, a subject to a semester, and a semester to one programme — so every
 * recorded note opening already says which programme it was, including all the
 * ones from before this report existed.
 */
export async function programAnalytics(days: number): Promise<ProgramStats[]> {
  const [notes, papers, catalogue, published] = await Promise.all([
    prisma.$queryRaw<
      { program: string; students: number; opens: number; students_all: number; opens_all: number }[]
    >`
      SELECT sem.program::text AS program,
             COUNT(DISTINCT e."userId") FILTER (
               WHERE e."createdAt" >= NOW() - (${days}::int * INTERVAL '1 day'))::int AS students,
             COUNT(*) FILTER (
               WHERE e."createdAt" >= NOW() - (${days}::int * INTERVAL '1 day'))::int AS opens,
             COUNT(DISTINCT e."userId")::int AS students_all,
             COUNT(*)::int AS opens_all
      FROM activity_events e
      JOIN users u ON u.id = e."userId" AND u.role = 'STUDENT'
      JOIN notes n ON n.id = e."noteId"
      JOIN subjects s ON s.id = n."subjectId"
      JOIN semesters sem ON sem.id = s."semesterId"
      WHERE e.type = 'NOTE_OPENED'
      GROUP BY sem.program
    `,
    prisma.$queryRaw<{ program: string; opens: number }[]>`
      SELECT sem.program::text AS program, COUNT(*)::int AS opens
      FROM activity_events e
      JOIN users u ON u.id = e."userId" AND u.role = 'STUDENT'
      JOIN subjects s ON s.id = e."subjectId"
      JOIN semesters sem ON sem.id = s."semesterId"
      WHERE e.type = 'PYQ_OPENED'
        AND e."createdAt" >= NOW() - (${days}::int * INTERVAL '1 day')
      GROUP BY sem.program
    `,
    prisma.$queryRaw<{ program: string; views: number }[]>`
      SELECT e.metadata->>'program' AS program, COUNT(*)::int AS views
      FROM activity_events e
      WHERE e.type = 'CATALOG_VIEWED'
        AND e.metadata->>'program' IS NOT NULL
        AND e."createdAt" >= NOW() - (${days}::int * INTERVAL '1 day')
      GROUP BY e.metadata->>'program'
    `,
    prisma.$queryRaw<{ program: string; notes: number }[]>`
      SELECT sem.program::text AS program, COUNT(n.id)::int AS notes
      FROM notes n
      JOIN subjects s ON s.id = n."subjectId"
      JOIN semesters sem ON sem.id = s."semesterId"
      WHERE n.status = 'PUBLISHED'
      GROUP BY sem.program
    `,
  ]);

  return (['BTECH', 'POLYTECHNIC'] as const).map((program) => {
    const n = notes.find((row) => row.program === program);
    return {
      program,
      students: n?.students ?? 0,
      noteOpens: n?.opens ?? 0,
      paperOpens: papers.find((row) => row.program === program)?.opens ?? 0,
      catalogueViews: catalogue.find((row) => row.program === program)?.views ?? 0,
      studentsAllTime: n?.students_all ?? 0,
      noteOpensAllTime: n?.opens_all ?? 0,
      publishedNotes: published.find((row) => row.program === program)?.notes ?? 0,
    };
  });
}
