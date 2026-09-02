import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { recordEvent } from '@/lib/analytics/events';
import type { RequestContext } from '@/lib/request';
import type { Role, UserStatus } from '@/generated/prisma/enums';
import type { SessionModel as Session, UserModel as User } from '@/generated/prisma/models';

export const SESSION_COOKIE = env.session.cookieName;
/** Non-authoritative role marker read by middleware. See setRoleHintCookie. */
export const ROLE_HINT_COOKIE = 'sv_role';

/** How stale `lastActivityAt` may get before we write to the database again. */
const TOUCH_THROTTLE_MS = 45_000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  college: string | null;
  program: string | null;
  semester: number | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface ActiveSession {
  id: string;
  userId: string;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
}

export type SessionState =
  | { status: 'authenticated'; user: SessionUser; session: ActiveSession }
  | { status: 'anonymous' }
  | { status: 'expired' }
  | { status: 'superseded' }
  | { status: 'terminated' }
  | { status: 'disabled' };

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

export function idleCutoff(now = new Date()): Date {
  return new Date(now.getTime() - env.session.idleMinutes * 60 * 1000);
}

export function liveCutoff(now = new Date()): Date {
  return new Date(now.getTime() - env.liveWindowMinutes * 60 * 1000);
}

/**
 * The one active session an account is allowed to have, or null.
 *
 * A row counts as live only when it is ACTIVE, inside its absolute lifetime and
 * has shown activity within the inactivity window — so a forgotten tab does not
 * lock the account out forever.
 */
export async function findLiveSession(userId: string, excludeSessionId?: string) {
  const now = new Date();
  return prisma.session.findFirst({
    where: {
      userId,
      status: 'ACTIVE',
      expiresAt: { gt: now },
      lastActivityAt: { gt: idleCutoff(now) },
      ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
    },
    orderBy: { lastActivityAt: 'desc' },
  });
}

/** Marks sessions that drifted past their idle/absolute window as EXPIRED. */
export async function expireStaleSessions(userId?: string): Promise<number> {
  const now = new Date();
  const result = await prisma.session.updateMany({
    where: {
      status: 'ACTIVE',
      ...(userId ? { userId } : {}),
      OR: [{ expiresAt: { lte: now } }, { lastActivityAt: { lte: idleCutoff(now) } }],
    },
    data: { status: 'EXPIRED', endedAt: now, endedReason: 'inactivity' },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createSession(
  userId: string,
  ctx: RequestContext,
): Promise<{ session: Session; token: string }> {
  const token = generateSessionToken();
  const now = new Date();

  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      status: 'ACTIVE',
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, 512) ?? null,
      device: ctx.device,
      browser: ctx.browser,
      os: ctx.os,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + env.session.absoluteHours * 60 * 60 * 1000),
    },
  });

  return { session, token };
}

export async function endSession(
  sessionId: string,
  status: 'LOGGED_OUT' | 'SUPERSEDED' | 'TERMINATED' | 'EXPIRED',
  reason: string,
): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, status: 'ACTIVE' },
    data: { status, endedAt: new Date(), endedReason: reason },
  });
}

/** Ends every other live session for the account (the "log me in here" path). */
export async function endOtherSessions(
  userId: string,
  keepSessionId: string | null,
  status: 'SUPERSEDED' | 'TERMINATED',
  reason: string,
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      status: 'ACTIVE',
      ...(keepSessionId ? { id: { not: keepSessionId } } : {}),
    },
    data: { status, endedAt: new Date(), endedReason: reason },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Cookie handling
// ---------------------------------------------------------------------------

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    maxAge: env.session.absoluteHours * 60 * 60,
  });
}

/**
 * A *hint* only, so middleware can bounce a student off /admin at the edge with
 * a real HTTP redirect instead of rendering a page that then redirects itself.
 *
 * It carries no authority: forging it gets you nothing, because every admin
 * page, action and API route re-reads the role from the database. It is
 * refreshed on every heartbeat so a role change takes effect within a minute.
 */
export async function setRoleHintCookie(role: Role): Promise<void> {
  const store = await cookies();
  store.set(ROLE_HINT_COOKIE, role, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    maxAge: env.session.absoluteHours * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  for (const name of [SESSION_COOKIE, ROLE_HINT_COOKIE]) {
    store.set(name, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProduction,
      path: '/',
      maxAge: 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Reading the current session
// ---------------------------------------------------------------------------

type SessionWithUser = Session & { user: User };

function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    college: user.college,
    program: user.program,
    semester: user.semester,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function toActiveSession(session: Session): ActiveSession {
  return {
    id: session.id,
    userId: session.userId,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    expiresAt: session.expiresAt,
    ipAddress: session.ipAddress,
    browser: session.browser,
    os: session.os,
    device: session.device,
  };
}

/**
 * Resolves the caller from the session cookie.
 *
 * This is the single place that decides whether a request is authenticated.
 * Every protected page, route handler and server action goes through it — the
 * client is never trusted for identity or role.
 */
export async function getSessionState(options: { touch?: boolean } = {}): Promise<SessionState> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return { status: 'anonymous' };

  let record: SessionWithUser | null = null;
  try {
    record = (await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    })) as SessionWithUser | null;
  } catch (error) {
    console.error('[session] lookup failed', error);
    return { status: 'anonymous' };
  }

  if (!record) return { status: 'anonymous' };

  const now = new Date();

  if (record.status !== 'ACTIVE') {
    if (record.status === 'SUPERSEDED') return { status: 'superseded' };
    if (record.status === 'TERMINATED') return { status: 'terminated' };
    if (record.status === 'EXPIRED') return { status: 'expired' };
    return { status: 'anonymous' };
  }

  if (record.expiresAt <= now || record.lastActivityAt <= idleCutoff(now)) {
    await endSession(record.id, 'EXPIRED', 'inactivity');
    await recordEvent({
      type: 'SESSION_EXPIRED',
      userId: record.userId,
      sessionId: record.id,
      metadata: { reason: record.expiresAt <= now ? 'absolute' : 'inactivity' },
    });
    return { status: 'expired' };
  }

  if (record.user.status !== 'ACTIVE') {
    await endSession(record.id, 'TERMINATED', 'account_not_active');
    return { status: 'disabled' };
  }

  if (options.touch !== false) {
    const drift = now.getTime() - record.lastActivityAt.getTime();
    if (drift > TOUCH_THROTTLE_MS) {
      // Fire-and-forget: a failed heartbeat write must never break a page render.
      void touchSession(record.id, record.userId).catch(() => undefined);
    }
  }

  return {
    status: 'authenticated',
    user: toSessionUser(record.user),
    session: toActiveSession(record),
  };
}

export async function touchSession(sessionId: string, userId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { id: sessionId, status: 'ACTIVE' },
      data: { lastActivityAt: now },
    }),
    prisma.user.update({ where: { id: userId }, data: { lastSeenAt: now } }),
  ]);
}

/** Number of distinct users genuinely active right now (heartbeat based). */
export async function countLiveUsers(): Promise<number> {
  const rows = await prisma.session.findMany({
    where: {
      status: 'ACTIVE',
      lastActivityAt: { gt: liveCutoff() },
      expiresAt: { gt: new Date() },
      user: { status: 'ACTIVE' },
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  return rows.length;
}
