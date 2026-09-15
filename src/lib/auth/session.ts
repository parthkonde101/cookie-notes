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
  /**
   * When this student proved control of a college email, or null.
   *
   * Carried on the session user so the guards can decide whether to send them
   * to the migration flow without a second query on every protected request.
   */
  emailVerifiedAt: Date | null;
  /** A college address proposed but not yet proved, so the form can prefill. */
  pendingEmail: string | null;
}

export interface ActiveSession {
  id: string;
  userId: string;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  /** "Keep me signed in" was ticked. Affects lifetime only, never activity. */
  rememberMe: boolean;
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

/**
 * Three clocks, deliberately independent.
 *
 *   absolute  how long a session may live at all      7 days  / 30 days remembered
 *   idle      how long it may sit unused              30 min  / 30 days remembered
 *   live      how recently it must have been used
 *             to count as an Active User              5 minutes, always
 *
 * "Keep me signed in" moves the first two and never the third. That separation
 * is the whole reason a remembered student does not inflate the Active Users
 * number: staying authenticated for a month is an authentication fact, being
 * "studying right now" is an activity fact, and only the activity clock feeds
 * the analytics.
 */

/** The idle window for an ordinary session. */
export function idleCutoff(now = new Date()): Date {
  return new Date(now.getTime() - env.session.idleMinutes * 60 * 1000);
}

/** The idle window for a remembered one. */
export function rememberedIdleCutoff(now = new Date()): Date {
  return new Date(now.getTime() - env.session.rememberDays * 24 * 60 * 60 * 1000);
}

/** The idle cutoff that applies to a particular session. */
export function idleCutoffFor(session: { rememberMe: boolean }, now = new Date()): Date {
  return session.rememberMe ? rememberedIdleCutoff(now) : idleCutoff(now);
}

/**
 * The Active Users window. Five minutes, for everyone, remembered or not.
 *
 * Do not make this depend on the session: widening it for remembered sessions
 * would silently redefine every "active now" number in the product.
 */
export function liveCutoff(now = new Date()): Date {
  return new Date(now.getTime() - env.liveWindowMinutes * 60 * 1000);
}

/** Seconds a session of this kind may live — also used as the cookie's maxAge. */
export function sessionLifetimeSeconds(rememberMe: boolean): number {
  return rememberMe
    ? env.session.rememberDays * 24 * 60 * 60
    : env.session.absoluteHours * 60 * 60;
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
      // Each session is judged against its own idle window: a remembered one
      // holds the account for as long as it is valid, an ordinary one still
      // falls stale after thirty minutes so a forgotten tab never locks a
      // student out.
      OR: [
        { rememberMe: false, lastActivityAt: { gt: idleCutoff(now) } },
        { rememberMe: true, lastActivityAt: { gt: rememberedIdleCutoff(now) } },
      ],
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
      OR: [
        { expiresAt: { lte: now } },
        { rememberMe: false, lastActivityAt: { lte: idleCutoff(now) } },
        { rememberMe: true, lastActivityAt: { lte: rememberedIdleCutoff(now) } },
      ],
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
  options: { rememberMe?: boolean } = {},
): Promise<{ session: Session; token: string }> {
  const token = generateSessionToken();
  const now = new Date();
  const rememberMe = options.rememberMe === true;

  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      status: 'ACTIVE',
      rememberMe,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, 512) ?? null,
      device: ctx.device,
      browser: ctx.browser,
      os: ctx.os,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + sessionLifetimeSeconds(rememberMe) * 1000),
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

/**
 * Writes the session cookie, matching its lifetime to the row's.
 *
 * HttpOnly throughout — the token is never readable by script and is never put
 * in localStorage or sessionStorage. "Keep me signed in" changes only how long
 * the browser keeps it; a cookie that outlived its database row would just be a
 * slower way of being signed out.
 */
export async function setSessionCookie(
  token: string,
  options: { rememberMe?: boolean } = {},
): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    maxAge: sessionLifetimeSeconds(options.rememberMe === true),
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
export async function setRoleHintCookie(
  role: Role,
  options: { rememberMe?: boolean } = {},
): Promise<void> {
  const store = await cookies();
  store.set(ROLE_HINT_COOKIE, role, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    // Kept in step with the session cookie: a role hint that outlives the
    // session would have middleware routing on a stale role.
    maxAge: sessionLifetimeSeconds(options.rememberMe === true),
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
    emailVerifiedAt: user.emailVerifiedAt,
    pendingEmail: user.pendingEmail,
  };
}

function toActiveSession(session: Session): ActiveSession {
  return {
    id: session.id,
    userId: session.userId,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    expiresAt: session.expiresAt,
    rememberMe: session.rememberMe,
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

  if (record.expiresAt <= now || record.lastActivityAt <= idleCutoffFor(record, now)) {
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
