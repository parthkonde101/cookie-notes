import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
import { canVerifyCurrentEmail } from '@/lib/auth/current-email';
import {
  issueCode,
  lastIssuedAt,
  OTP_MAX_ATTEMPTS,
  OTP_PURPOSE,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  verifyCode,
} from '@/lib/auth/otp';
import { rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { sendMail, verificationCodeEmail } from '@/lib/mail';
import { confirmEmailChangeSchema, firstError } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Proving control of the address an existing student already has.
 *
 * The college-email migration moves an account to a DIFFERENT address. A student
 * who is already on `@mitwpu.edu.in` has nowhere to move, so this is the other
 * half: send a code to the address on the account and, when it comes back
 * correct, record that the mailbox was proved. Nothing else about the account
 * changes — not the email, not the id, not the password, the grants or the
 * session the student is using.
 *
 * Rules that hold throughout:
 *
 * There is no address in any request. The account comes from the session and the
 * address is that account's own, read from the database. So nothing a client
 * sends can name a different mailbox, or aim this at someone else's account, and
 * there is no input that could be used to ask "does this address exist?".
 *
 * The domain is not proof. It decides only whether this path is offered; the
 * account is marked verified by a correct, unexpired, unspent code that was
 * delivered to the address, and never because of what the address looks like.
 *
 * The OTP machinery is the existing one — same generator, SHA-256 storage,
 * ten-minute expiry, five attempts, single use, supersede-on-reissue and resend
 * cooldown. Only the purpose differs, so a code issued here cannot be spent on
 * sign-up or on an address change, nor theirs on this.
 */

const PURPOSE = OTP_PURPOSE.currentEmail;

/** Send a code to the address on the account. No request body is read. */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireApiUser({ allowUnverified: true });
    const ctx = contextFromHeaders(request.headers);

    if (user.emailVerifiedAt) {
      return NextResponse.json({ ok: true, verified: true, alreadyVerified: true });
    }
    if (!canVerifyCurrentEmail(user)) {
      throw Errors.validation(
        'Your account uses a different address. Use “Update your college email” to move to your MIT-WPU address.',
      );
    }

    // Keyed to the account, so one session cannot be used to bomb a mailbox.
    const perUser = await rateLimit(`currentemail:user:${user.id}`, 5, 60);
    const perIp = await rateLimit(`currentemail:ip:${ctx.ip ?? 'unknown'}`, 15, 60);
    if (!perUser.allowed || !perIp.allowed) {
      throw Errors.rateLimited('Too many attempts. Please wait a few minutes and try again.');
    }

    // A short cooldown on top of the hourly limit, so the button cannot be held
    // down to generate a stream of emails.
    const issued = await lastIssuedAt(user.id, PURPOSE);
    if (issued && Date.now() - issued.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      return NextResponse.json({
        ok: true,
        cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
        expiresInMinutes: OTP_TTL_MINUTES,
      });
    }

    const { code } = await issueCode(user.id, ctx.ip, PURPOSE);

    const result = await sendMail({
      ...verificationCodeEmail(user.name, code, OTP_TTL_MINUTES),
      subject: 'Verify your MIT-WPU email for Cookie Notes',
      to: user.email,
    });

    if (!result.delivered) {
      // Never claim a code was sent when it was not. A driver asked to send real
      // mail and failing is an error; the explicit console driver is a
      // development choice that prints to the terminal.
      console.error(`[verify-current-email] code was logged, not emailed (driver=${result.driver})`);
      if (env.mail.driver === 'resend') {
        throw Errors.internal('We could not send the verification email. Please try again shortly.');
      }
    }

    await recordEvent({
      type: 'EMAIL_VERIFICATION_SENT',
      userId: user.id,
      ctx,
      metadata: { flow: 'current_email_verification' },
    });

    return NextResponse.json({
      ok: true,
      cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      expiresInMinutes: OTP_TTL_MINUTES,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Confirm the code and record that the current address was proved. */
export async function PUT(request: NextRequest) {
  try {
    const { user, session } = await requireApiUser({ allowUnverified: true });
    const ctx = contextFromHeaders(request.headers);

    const body = await request.json().catch(() => null);
    const parsed = confirmEmailChangeSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));
    const { code } = parsed.data;

    const perUser = await rateLimit(`currentemailconfirm:user:${user.id}`, 10, 10);
    const perIp = await rateLimit(`currentemailconfirm:ip:${ctx.ip ?? 'unknown'}`, 30, 60);
    if (!perUser.allowed || !perIp.allowed) {
      throw Errors.rateLimited('Too many attempts. Please wait a few minutes and try again.');
    }

    // Already done: idempotent rather than an error, so a double-submitted form
    // does not look like a failure.
    if (user.emailVerifiedAt) {
      return NextResponse.json({ ok: true, verified: true, alreadyVerified: true });
    }
    if (!canVerifyCurrentEmail(user)) {
      throw Errors.validation(
        'Your account uses a different address. Use “Update your college email” to move to your MIT-WPU address.',
      );
    }

    const outcome = await verifyCode(user.id, code, PURPOSE);

    if (!outcome.ok) {
      await recordEvent({
        type: 'EMAIL_VERIFICATION_FAILED',
        userId: user.id,
        ctx,
        // The reason, never the code.
        metadata: { reason: outcome.reason, flow: 'current_email_verification' },
      });
      if (outcome.reason === 'too_many_attempts') {
        throw Errors.validation(
          `That code has been locked after ${OTP_MAX_ATTEMPTS} incorrect attempts. Request a new one.`,
        );
      }
      throw Errors.validation('That code is not valid or has expired. Request a new one.');
    }

    // The code is spent (consumed by one request only, by the database). Now
    // record the proof — but only against the address it was sent to: if the
    // account's address has moved since this request began, nothing is marked.
    const marked = await prisma.user.updateMany({
      where: { id: user.id, email: user.email, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    if (marked.count !== 1) {
      throw Errors.validation('That code is not valid or has expired. Request a new one.');
    }

    await recordEvent({
      type: 'EMAIL_VERIFIED',
      userId: user.id,
      sessionId: session.id,
      ctx,
      metadata: { flow: 'current_email_verification' },
    });

    // No email changed, so there is no "your address was changed" notice to send,
    // and the session is untouched: it is keyed to a token, not to an address.
    return NextResponse.json({ ok: true, verified: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
