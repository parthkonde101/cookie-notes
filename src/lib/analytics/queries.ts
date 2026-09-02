import 'server-only';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { liveCutoff } from '@/lib/auth/session';

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
    mostViewedNote,
    mostActiveUsers,
    liveWindowMinutes: env.liveWindowMinutes,
  };
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
