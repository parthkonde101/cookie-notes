import { NextResponse, type NextRequest } from 'next/server';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
import { canVerifyCurrentEmail } from '@/lib/auth/current-email';
import {
  OTP_MAX_ATTEMPTS,
  OTP_PURPOSE,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  verifyCode,
} from '@/lib/auth/otp';
import { issueAndSendCode } from '@/lib/auth/send-code';
import { assertWithinLimits, rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { verificationCodeEmail } from '@/lib/mail';
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

/** Thrown inside the claim transaction to roll it back when the account can no longer be marked. */
class NotMarkable extends Error {}

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
    // Fails closed: if the limiter cannot run, that is not permission to send.
    const perUser = await rateLimit(`currentemail:user:${user.id}`, 5, 60, { failClosed: true });
    const perIp = await rateLimit(`currentemail:ip:${ctx.ip ?? 'unknown'}`, 15, 60, { failClosed: true });
    assertWithinLimits(perUser, perIp);

    // The code is bound to this account's own address and nothing else, and it is
    // issued under the lock that serialises issuing for this account — so a held
    // down button, or a burst of requests, leaves exactly one code in force.
    const sent = await issueAndSendCode({
      userId: user.id,
      purpose: PURPOSE,
      address: user.email,
      ipAddress: ctx.ip,
      // Checked inside that lock, and measured against the most recent code
      // whether or not it is still live.
      cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      label: 'verify-current-email',
      message: (code) => ({
        ...verificationCodeEmail(user.name, code, OTP_TTL_MINUTES),
        subject: 'Verify your MIT-WPU email for Cookie Notes',
        to: user.email,
      }),
    });

    if (sent.status === 'cooldown') {
      // A code that is still usable was sent a moment ago: say so. Otherwise the
      // last one was locked out or could not be delivered, and a retry must not
      // read as though an email is on its way.
      if (sent.live) {
        return NextResponse.json({
          ok: true,
          cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
          expiresInMinutes: OTP_TTL_MINUTES,
        });
      }
      throw Errors.rateLimited(
        `Please wait ${sent.retryAfterSeconds} seconds before requesting another code.`,
      );
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

    const perUser = await rateLimit(`currentemailconfirm:user:${user.id}`, 10, 10, { failClosed: true });
    const perIp = await rateLimit(`currentemailconfirm:ip:${ctx.ip ?? 'unknown'}`, 30, 60, { failClosed: true });
    assertWithinLimits(perUser, perIp);

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

    // Spending the code and marking the account are ONE transaction. If the mark
    // cannot be made — the database fails, or the account's address has moved
    // since this request began — the code is not spent, so the student is never
    // left with a burned code and an unverified account.
    //
    // The mark is only ever made against the address the code was bound to.
    let outcome;
    try {
      outcome = await verifyCode({
        userId: user.id,
        code,
        purpose: PURPOSE,
        address: user.email,
        onClaim: async (tx) => {
          const marked = await tx.user.updateMany({
            where: { id: user.id, email: user.email, emailVerifiedAt: null },
            data: { emailVerifiedAt: new Date() },
          });
          if (marked.count !== 1) throw new NotMarkable();
        },
      });
    } catch (error) {
      if (error instanceof NotMarkable) {
        throw Errors.validation('That code is not valid or has expired. Request a new one.');
      }
      throw error;
    }

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
