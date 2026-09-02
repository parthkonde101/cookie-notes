import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders, describeDevice } from '@/lib/request';
import { fakeVerify, verifyPassword } from '@/lib/auth/password';
import {
  createSession,
  endOtherSessions,
  expireStaleSessions,
  findLiveSession,
  setRoleHintCookie,
  setSessionCookie,
} from '@/lib/auth/session';
import { rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import { firstError, loginSchema } from '@/lib/validation';
import { relativeTime } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GENERIC_FAILURE = 'That email and password combination is not correct.';

export async function POST(request: NextRequest) {
  try {
    const ctx = contextFromHeaders(request.headers);

    const body = await request.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const { email, password, force } = parsed.data;

    // Two limiters: one per network, one per account, so neither a single IP
    // nor a single account can be hammered.
    const ipLimit = await rateLimit(
      `login:ip:${ctx.ip ?? 'unknown'}`,
      env.rateLimit.loginMaxAttempts * 3,
      env.rateLimit.loginWindowMinutes,
    );
    const accountLimit = await rateLimit(
      `login:email:${email}`,
      env.rateLimit.loginMaxAttempts,
      env.rateLimit.loginWindowMinutes,
    );

    if (!ipLimit.allowed || !accountLimit.allowed) {
      await recordEvent({ type: 'LOGIN_BLOCKED', ctx, metadata: { email, reason: 'rate_limited' } });
      throw Errors.rateLimited(
        `Too many sign-in attempts. Please try again in about ${Math.ceil(
          Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds) / 60,
        )} minute(s).`,
      );
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      await fakeVerify(); // keep timing similar whether or not the account exists
      await recordEvent({ type: 'LOGIN_FAILED', ctx, metadata: { email, reason: 'no_account' } });
      throw Errors.validation(GENERIC_FAILURE);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await recordEvent({
        type: 'LOGIN_BLOCKED',
        userId: user.id,
        ctx,
        metadata: { reason: 'locked' },
      });
      throw Errors.rateLimited(
        'This account is temporarily locked after several failed attempts. Try again shortly.',
      );
    }

    const passwordOk = await verifyPassword(password, user.passwordHash);

    if (!passwordOk) {
      const failedLoginCount = user.failedLoginCount + 1;
      const shouldLock = failedLoginCount >= env.rateLimit.loginMaxAttempts;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount,
          lockedUntil: shouldLock
            ? new Date(Date.now() + env.rateLimit.lockoutMinutes * 60 * 1000)
            : null,
        },
      });
      await recordEvent({
        type: 'LOGIN_FAILED',
        userId: user.id,
        ctx,
        metadata: { reason: 'bad_password', attempt: failedLoginCount },
      });
      throw Errors.validation(GENERIC_FAILURE);
    }

    if (user.status !== 'ACTIVE') {
      await recordEvent({
        type: 'LOGIN_BLOCKED',
        userId: user.id,
        ctx,
        metadata: { reason: user.status.toLowerCase() },
      });
      throw Errors.forbidden(
        'This account has been disabled. Please contact support if you think this is a mistake.',
      );
    }

    // --- One account, one active session -----------------------------------
    // Clean up anything that has drifted past its inactivity window first, so a
    // forgotten browser tab never locks a student out of their own account.
    await expireStaleSessions(user.id);
    const live = await findLiveSession(user.id);

    if (live && !force) {
      await recordEvent({
        type: 'LOGIN_BLOCKED',
        userId: user.id,
        ctx,
        metadata: { reason: 'session_conflict', otherSessionId: live.id },
      });
      throw Errors.sessionConflict({
        device: describeDevice(live),
        ipAddress: live.ipAddress,
        lastActiveLabel: relativeTime(live.lastActivityAt),
        startedLabel: relativeTime(live.createdAt),
      });
    }

    let supersededCount = 0;
    if (live && force) {
      supersededCount = await endOtherSessions(user.id, null, 'SUPERSEDED', 'new_login');
      await recordEvent({
        type: 'SESSION_TERMINATED',
        userId: user.id,
        sessionId: live.id,
        ctx,
        metadata: { reason: 'superseded_by_new_login', count: supersededCount },
      });
    }

    const { session, token } = await createSession(user.id, ctx);
    await setSessionCookie(token);
    await setRoleHintCookie(user.role);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        lastSeenAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    await recordEvent({ type: 'LOGIN_SUCCESS', userId: user.id, sessionId: session.id, ctx });
    await recordEvent({ type: 'SESSION_CREATED', userId: user.id, sessionId: session.id, ctx });

    if (user.role === 'ADMIN') {
      await writeAudit({
        action: 'ADMIN_LOGIN',
        actorId: user.id,
        actorEmail: user.email,
        targetType: 'session',
        targetId: session.id,
        ctx,
      });
    }

    return NextResponse.json({
      ok: true,
      redirectTo: user.role === 'ADMIN' ? '/admin' : '/',
      supersededSessions: supersededCount,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
