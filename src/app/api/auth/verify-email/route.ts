import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import {
  issueCode,
  lastIssuedAt,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  verifyCode,
} from '@/lib/auth/otp';
import { rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { sendMail, verificationCodeEmail } from '@/lib/mail';
import { firstError, resendCodeSchema, verifyEmailSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Finishing sign-up: exchange the emailed code for a verified address.
 *
 * This endpoint does NOT sign anybody in. A correct code proves the person
 * reading this mailbox asked to register; it does not prove they know the
 * password. They go to the sign-in form afterwards like anyone else, which also
 * means a leaked code cannot by itself get anyone into an account.
 *
 * Note what verification does and does not establish: the student controls an
 * @mitwpu.edu.in address. The PRN they typed is self-declared and is not
 * corroborated by anything here.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = contextFromHeaders(request.headers);

    const body = await request.json().catch(() => null);
    const parsed = verifyEmailSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));
    const { email, code } = parsed.data;

    // Two limiters: the per-address one bounds guessing at a specific account,
    // the per-network one bounds sweeping across many.
    const perEmail = await rateLimit(`verify:email:${email}`, 5, 10);
    const perIp = await rateLimit(`verify:ip:${ctx.ip ?? 'unknown'}`, 20, 60);
    if (!perEmail.allowed || !perIp.allowed) {
      throw Errors.rateLimited('Too many attempts. Please wait a few minutes and try again.');
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true, emailVerifiedAt: true, verificationRequired: true },
    });

    // One message for every failure below, so the endpoint cannot be used to
    // learn whether an address is registered or awaiting verification.
    const genericFailure = Errors.validation(
      'That code is not valid or has expired. Request a new one.',
    );

    if (!user || user.status !== 'ACTIVE' || !user.verificationRequired) throw genericFailure;

    // Already done. Idempotent rather than an error: a double-submitted form
    // should not look like a failure.
    if (user.emailVerifiedAt) {
      return NextResponse.json({ ok: true, verified: true, alreadyVerified: true });
    }

    const outcome = await verifyCode(user.id, code);

    if (!outcome.ok) {
      await recordEvent({
        type: 'EMAIL_VERIFICATION_FAILED',
        userId: user.id,
        ctx,
        // The reason, never the code.
        metadata: { reason: outcome.reason },
      });

      if (outcome.reason === 'too_many_attempts') {
        throw Errors.validation(
          `That code has been locked after ${OTP_MAX_ATTEMPTS} incorrect attempts. Request a new one.`,
        );
      }
      throw genericFailure;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });

    await recordEvent({ type: 'EMAIL_VERIFIED', userId: user.id, ctx });

    // Deliberately no session, no cookie: verification is not authentication.
    return NextResponse.json({ ok: true, verified: true, redirectTo: '/login?verified=1' });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Sends another code.
 *
 * Answers the same way whatever the address is, so it cannot be used to test
 * membership, and is cooled down per address so it cannot be used to bomb a
 * mailbox. Issuing supersedes the previous code, so "resend" never widens the
 * set of codes that work.
 */
export async function PUT(request: NextRequest) {
  try {
    const ctx = contextFromHeaders(request.headers);

    const body = await request.json().catch(() => null);
    const parsed = resendCodeSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));
    const { email } = parsed.data;

    const perIp = await rateLimit(`resend:ip:${ctx.ip ?? 'unknown'}`, 10, 60);
    const perEmail = await rateLimit(`resend:email:${email}`, 3, 60);
    if (!perIp.allowed || !perEmail.allowed) {
      // Same body as success — a different answer here would be an oracle.
      return sentResponse();
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, status: true, emailVerifiedAt: true, verificationRequired: true },
    });

    if (!user || user.status !== 'ACTIVE' || !user.verificationRequired || user.emailVerifiedAt) {
      return sentResponse();
    }

    // A short cooldown on top of the hourly limit, so the button cannot be
    // held down to generate a stream of emails.
    const issued = await lastIssuedAt(user.id);
    if (issued && Date.now() - issued.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      return sentResponse();
    }

    const { code } = await issueCode(user.id, ctx.ip);
    const result = await sendMail({
      ...verificationCodeEmail(user.name, code, OTP_TTL_MINUTES),
      to: email,
    });

    if (!result.delivered) {
      // Same rule as registration: a driver that was asked to send real mail
      // and did not is an error; an explicit console driver is a choice.
      console.error(`[verify-email] code was logged, not emailed (driver=${result.driver})`);
      if (env.mail.driver === 'resend') {
        throw Errors.internal(
          'We could not send your verification email. Please try again shortly.',
        );
      }
    }

    await recordEvent({ type: 'EMAIL_VERIFICATION_SENT', userId: user.id, ctx, metadata: { resend: true } });
    return sentResponse();
  } catch (error) {
    return toErrorResponse(error);
  }
}

function sentResponse() {
  return NextResponse.json({
    ok: true,
    message: 'If that address is waiting to be verified, a new code is on its way.',
    cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    expiresInMinutes: OTP_TTL_MINUTES,
  });
}
