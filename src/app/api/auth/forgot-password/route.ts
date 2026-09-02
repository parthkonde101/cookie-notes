import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { createOpaqueToken } from '@/lib/tokens';
import { passwordResetEmail, sendMail } from '@/lib/mail';
import { firstError, forgotPasswordSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESET_TTL_MINUTES = 60;

export async function POST(request: NextRequest) {
  try {
    const ctx = contextFromHeaders(request.headers);

    const limit = await rateLimit(`forgot:${ctx.ip ?? 'unknown'}`, 5, 15);
    if (!limit.allowed) throw Errors.rateLimited();

    const body = await request.json().catch(() => null);
    const parsed = forgotPasswordSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const { email } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });

    // Always answer the same way: the endpoint must not reveal who has an account.
    if (user && user.status === 'ACTIVE') {
      const token = createOpaqueToken();
      const tokenHash = createHash('sha256').update(token).digest('hex');

      await prisma.$transaction([
        // One live reset link at a time.
        prisma.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        }),
        prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash,
            ipAddress: ctx.ip,
            expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000),
          },
        }),
      ]);

      const url = `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;

      try {
        await sendMail({
          to: user.email,
          subject: 'Reset your Cookie Notes password',
          text: passwordResetEmail(user.name, url),
        });
      } catch (mailError) {
        console.error('[forgot-password] mail delivery failed', mailError);
      }

      await recordEvent({ type: 'PASSWORD_RESET_REQUESTED', userId: user.id, ctx });
    }

    return NextResponse.json({
      ok: true,
      message: 'If an account exists for that email, a reset link is on its way.',
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
