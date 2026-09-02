import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { checkPasswordStrength, hashPassword } from '@/lib/auth/password';
import { endOtherSessions } from '@/lib/auth/session';
import { rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import { firstError, resetPasswordSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const ctx = contextFromHeaders(request.headers);

    const limit = await rateLimit(`reset:${ctx.ip ?? 'unknown'}`, 10, 15);
    if (!limit.allowed) throw Errors.rateLimited();

    const body = await request.json().catch(() => null);
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const { token, password } = parsed.data;
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      throw Errors.validation('This reset link is invalid or has expired. Request a new one.');
    }
    if (record.user.status !== 'ACTIVE') {
      throw Errors.forbidden('This account is not active.');
    }

    const strength = checkPasswordStrength(password, record.user.email);
    if (!strength.ok) throw Errors.validation(strength.problems[0]!);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await hashPassword(password),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    // A password change invalidates every existing session for that account.
    await endOtherSessions(record.userId, null, 'TERMINATED', 'password_reset');

    await recordEvent({ type: 'PASSWORD_RESET_COMPLETED', userId: record.userId, ctx });
    await writeAudit({
      action: 'USER_PASSWORD_RESET',
      actorId: record.userId,
      actorEmail: record.user.email,
      targetType: 'user',
      targetId: record.userId,
      targetLabel: record.user.email,
      metadata: { via: 'self_service_reset' },
      ctx,
    });

    return NextResponse.json({
      ok: true,
      message: 'Password updated. You can sign in with your new password now.',
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
