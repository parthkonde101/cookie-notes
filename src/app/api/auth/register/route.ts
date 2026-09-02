import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { checkPasswordStrength, hashPassword } from '@/lib/auth/password';
import { createSession, setRoleHintCookie, setSessionCookie } from '@/lib/auth/session';
import { rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { firstError, registerSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const ctx = contextFromHeaders(request.headers);

    const limit = await rateLimit(
      `register:${ctx.ip ?? 'unknown'}`,
      env.rateLimit.registerMaxPerHour,
      60,
    );
    if (!limit.allowed) {
      throw Errors.rateLimited('Too many sign-up attempts from this network. Try again later.');
    }

    const body = await request.json().catch(() => null);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const { name, email, password, college, program, semester } = parsed.data;

    const strength = checkPasswordStrength(password, email);
    if (!strength.ok) throw Errors.validation(strength.problems[0]!);

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw Errors.conflict('An account with this email already exists. Try signing in instead.');
    }

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: await hashPassword(password),
        role: 'STUDENT',
        status: 'ACTIVE',
        college: college || null,
        program: program || null,
        semester: semester ?? null,
        lastLoginAt: new Date(),
      },
    });

    const { session, token } = await createSession(user.id, ctx);
    await setSessionCookie(token);
    await setRoleHintCookie(user.role);

    await recordEvent({ type: 'USER_REGISTERED', userId: user.id, sessionId: session.id, ctx });
    await recordEvent({ type: 'ACCOUNT_CREATED', userId: user.id, ctx, metadata: { via: 'self_signup' } });
    await recordEvent({ type: 'SESSION_CREATED', userId: user.id, sessionId: session.id, ctx });

    return NextResponse.json({ ok: true, redirectTo: '/' }, { status: 201 });
  } catch (error) {
    // Unique-constraint race: two requests for the same email at once.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      return toErrorResponse(Errors.conflict('An account with this email already exists.'));
    }
    return toErrorResponse(error);
  }
}
