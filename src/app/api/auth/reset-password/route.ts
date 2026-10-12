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

    // Hashed before the transaction opens, so the slow hash never holds a lock.
    const passwordHash = await hashPassword(password);

    // The link is CLAIMED and the password changed in one transaction. The claim
    // is a conditional update — it only matches while the link is still unused and
    // unexpired — so of any number of simultaneous requests carrying the same
    // link exactly one gets count = 1; the rest find nothing and are refused. The
    // earlier version read the link and then updated it unconditionally, so two
    // requests could both pass the read and both change the password. If the
    // password update fails, the claim rolls back with it and the link stays good.
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new LinkAlreadyUsed();

      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      });
    });

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
    if (error instanceof LinkAlreadyUsed) {
      return toErrorResponse(
        Errors.validation('This reset link is invalid or has expired. Request a new one.'),
      );
    }
    return toErrorResponse(error);
  }
}

/** Thrown inside the reset transaction when another request used the link first. */
class LinkAlreadyUsed extends Error {}
