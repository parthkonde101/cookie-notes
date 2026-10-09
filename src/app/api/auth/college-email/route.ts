import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
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
import { sendMail, verificationCodeEmail } from '@/lib/mail';
import {
  confirmEmailChangeSchema,
  firstError,
  isStudentEmail,
  requestEmailChangeSchema,
} from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Moving an existing student to a verified college address.
 *
 * This is a migration, not a registration. The account already exists, already
 * has notes, grants and history, and keeps all of it — the only thing that
 * changes is which address it logs in with, and only once that address has been
 * proved.
 *
 * Three rules hold throughout:
 *
 * The account is always taken from the session. There is no user id in any
 * request body here; `requireApiUser` resolves the caller from the session
 * cookie, so no request can aim this at somebody else's account.
 *
 * The old address survives every failure. A proposed address lives in
 * `pendingEmail` until a correct code arrives; a wrong code, an expired one, a
 * closed tab or a second thought all leave `email` exactly as it was. Nothing
 * is ever sent to the old address — the point is to prove the new one.
 *
 * `allowUnverified: true` is the one place that flag is used. Every caller here
 * is by definition an unverified student, so the gate that keeps them out of
 * note content has to stand aside for the flow that lets them fix it.
 *
 * The OTP machinery is the existing one: same generator, same SHA-256 storage,
 * same ten-minute expiry, five attempts, single use and supersede-on-reissue.
 * Only the `purpose` differs, so a sign-up code and a migration code can never
 * be spent on each other.
 */

const PURPOSE = OTP_PURPOSE.emailChange;

/** Thrown inside the claim transaction to roll it back when the address cannot be adopted. */
class AddressUnavailable extends Error {}

/** Propose a college address and send a code to it. */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireApiUser({ allowUnverified: true });
    const ctx = contextFromHeaders(request.headers);

    const body = await request.json().catch(() => null);
    const parsed = requestEmailChangeSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));
    const { email } = parsed.data;

    // Keyed to the account, not the address, so nobody can use this endpoint to
    // spray codes at many mailboxes from one session. Fails closed: if the
    // limiter cannot run, that is not permission to send.
    const perUser = await rateLimit(`emailchange:user:${user.id}`, 5, 60, { failClosed: true });
    const perIp = await rateLimit(`emailchange:ip:${ctx.ip ?? 'unknown'}`, 15, 60, { failClosed: true });
    assertWithinLimits(perUser, perIp);

    if (email === user.email) {
      // A student already on a college address is not stuck: they can verify it
      // as it stands. Say so, instead of leaving them at a dead end.
      throw Errors.validation(
        isStudentEmail(user.email)
          ? 'That is the address you already have. Choose “Verify my current email” to confirm it, or enter a different MIT-WPU address.'
          : 'That is already your email address.',
      );
    }

    // Somebody else may already own it. Never overwrite, never merge — and say
    // as little as possible about why, so this cannot be used to test which
    // college addresses have accounts.
    const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (owner && owner.id !== user.id) {
      await recordEvent({
        type: 'EMAIL_VERIFICATION_FAILED',
        userId: user.id,
        ctx,
        metadata: { reason: 'address_in_use' },
      });
      throw Errors.validation(
        'That address cannot be used for this account. Try another MIT-WPU address, or contact support.',
      );
    }

    // The proposal and the code that proves it are recorded in ONE transaction,
    // under the lock that serialises issuing for this account — and the code is
    // bound to this exact address. So whatever order simultaneous requests run
    // in, the address on file and the code in force always agree, and a code that
    // was sent to one address can never promote another.
    //
    // `email` is untouched, so the student can still sign in with their original
    // address the whole time.
    const sent = await issueAndSendCode({
      userId: user.id,
      purpose: PURPOSE,
      address: email,
      ipAddress: ctx.ip,
      cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      inTransaction: async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { pendingEmail: email } });
      },
      label: 'college-email',
      message: (code) => ({
        ...verificationCodeEmail(user.name, code, OTP_TTL_MINUTES),
        subject: 'Verify your MIT-WPU email for Cookie Notes',
        to: email,
      }),
    });

    if (sent.status === 'cooldown') {
      // Only claim a code was sent when one was — and sent to THIS address.
      const proposed = await prisma.user.findUnique({
        where: { id: user.id },
        select: { pendingEmail: true },
      });
      if (sent.live && proposed?.pendingEmail === email) {
        return NextResponse.json({
          ok: true,
          pendingEmail: email,
          cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
          expiresInMinutes: OTP_TTL_MINUTES,
        });
      }
      throw Errors.rateLimited(
        sent.live
          ? `A code was just sent to a different address. Please wait ${sent.retryAfterSeconds} seconds before changing it.`
          : `Please wait ${sent.retryAfterSeconds} seconds before requesting another code.`,
      );
    }

    await recordEvent({
      type: 'EMAIL_VERIFICATION_SENT',
      userId: user.id,
      ctx,
      metadata: { flow: 'college_email_migration' },
    });

    return NextResponse.json({
      ok: true,
      pendingEmail: email,
      cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      expiresInMinutes: OTP_TTL_MINUTES,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Confirm the code and adopt the address.
 *
 * The only place `email` is written. Everything else about the account — id,
 * password hash, role, status, grants, notes, history, created date — is
 * untouched, and the session the student is using stays valid.
 */
export async function PUT(request: NextRequest) {
  try {
    const { user, session } = await requireApiUser({ allowUnverified: true });
    const ctx = contextFromHeaders(request.headers);

    const body = await request.json().catch(() => null);
    const parsed = confirmEmailChangeSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));
    const { code } = parsed.data;

    const perUser = await rateLimit(`emailconfirm:user:${user.id}`, 10, 10, { failClosed: true });
    const perIp = await rateLimit(`emailconfirm:ip:${ctx.ip ?? 'unknown'}`, 30, 60, { failClosed: true });
    assertWithinLimits(perUser, perIp);

    const current = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { pendingEmail: true, emailVerifiedAt: true, name: true },
    });

    // Nothing proposed — or already finished. Either way there is no code to
    // spend.
    if (current.emailVerifiedAt) {
      return NextResponse.json({ ok: true, verified: true, alreadyVerified: true });
    }
    if (!current.pendingEmail) {
      throw Errors.validation('Enter your MIT-WPU email address first.');
    }
    const proposed = current.pendingEmail;
    const previousEmail = user.email;

    // The code is checked against the address it must have been sent to: the one
    // now on file as the proposal. A code mailed anywhere else does not match.
    //
    // Spending the code and moving the address are one transaction: if the move
    // cannot be made, the code is not spent, and if it is made, the code is.
    let outcome;
    try {
      outcome = await verifyCode({
        userId: user.id,
        code,
        purpose: PURPOSE,
        address: proposed,
        onClaim: async (tx) => {
          // Re-check ownership at the moment of promotion. Between proposing and
          // proving, somebody else may have taken the address; the unique index
          // would catch it, but a clear message beats a constraint error.
          const owner = await tx.user.findUnique({ where: { email: proposed }, select: { id: true } });
          if (owner && owner.id !== user.id) throw new AddressUnavailable();

          // Only while the account still holds this proposal and is unverified.
          const moved = await tx.user.updateMany({
            where: { id: user.id, pendingEmail: proposed, emailVerifiedAt: null },
            data: { email: proposed, emailVerifiedAt: new Date(), pendingEmail: null },
          });
          if (moved.count !== 1) throw new AddressUnavailable();
        },
      });
    } catch (error) {
      // The address was taken, or a racing promotion got there first (the unique
      // index). Nothing moved and the code was not spent; drop the proposal so
      // the student chooses another.
      const racing =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
      if (error instanceof AddressUnavailable || racing) {
        await prisma.user.updateMany({
          where: { id: user.id, pendingEmail: proposed },
          data: { pendingEmail: null },
        });
        throw Errors.validation(
          'That address cannot be used for this account. Try another MIT-WPU address, or contact support.',
        );
      }
      throw error;
    }

    if (!outcome.ok) {
      await recordEvent({
        type: 'EMAIL_VERIFICATION_FAILED',
        userId: user.id,
        ctx,
        // The reason, never the code.
        metadata: { reason: outcome.reason, flow: 'college_email_migration' },
      });
      if (outcome.reason === 'too_many_attempts') {
        throw Errors.validation(
          `That code has been locked after ${OTP_MAX_ATTEMPTS} incorrect attempts. Request a new one.`,
        );
      }
      // The proposed address stays put so a retry does not start from scratch.
      throw Errors.validation('That code is not valid or has expired. Request a new one.');
    }

    await recordEvent({
      type: 'EMAIL_VERIFIED',
      userId: user.id,
      sessionId: session.id,
      ctx,
      metadata: { flow: 'college_email_migration' },
    });

    // Tell the old address that its account moved. It is the only message the
    // previous mailbox gets, and it is the one that matters: if this was not
    // the student, this is how they find out.
    await sendMail({
      to: previousEmail,
      subject: 'Your Cookie Notes email address was changed',
      text: [
        `Hi ${current.name},`,
        '',
        'The email address on your Cookie Notes account has been changed to your',
        'verified MIT-WPU address. Sign in with that address from now on.',
        '',
        'If this was not you, contact support straight away.',
        '',
        '—',
        'Cookie Notes · Baked for exams.',
      ].join('\n'),
    }).catch((error) => {
      // Informational. The change is already done and correct.
      console.error('[college-email] change-notice mail failed', error);
    });

    // The session continues. It is keyed to a session token, not to an email,
    // so nothing about it is stale — and signing the student out here would
    // mean punishing them for doing what we asked.
    return NextResponse.json({ ok: true, verified: true, email: proposed });
  } catch (error) {
    return toErrorResponse(error);
  }
}
