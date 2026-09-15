import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
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
import {
  confirmEmailChangeSchema,
  firstError,
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

const PURPOSE = 'email_change';

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
    // spray codes at many mailboxes from one session.
    const perUser = await rateLimit(`emailchange:user:${user.id}`, 5, 60);
    const perIp = await rateLimit(`emailchange:ip:${ctx.ip ?? 'unknown'}`, 15, 60);
    if (!perUser.allowed || !perIp.allowed) {
      throw Errors.rateLimited('Too many attempts. Please wait a few minutes and try again.');
    }

    if (email === user.email) {
      throw Errors.validation('That is already your email address.');
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

    // A short cooldown so the button cannot be held down to bomb a mailbox.
    const issued = await lastIssuedAt(user.id, PURPOSE);
    if (issued && Date.now() - issued.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      return NextResponse.json({
        ok: true,
        pendingEmail: email,
        cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
        expiresInMinutes: OTP_TTL_MINUTES,
      });
    }

    // Recorded as *proposed*, not adopted. `email` is untouched, so the student
    // can still sign in with their original address the whole time.
    await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: email } });

    const { code } = await issueCode(user.id, ctx.ip, PURPOSE);

    const result = await sendMail({
      ...verificationCodeEmail(user.name, code, OTP_TTL_MINUTES),
      subject: 'Verify your MIT-WPU email for Cookie Notes',
      to: email,
    });

    if (!result.delivered) {
      // Never claim a code was sent when it was not. Same rule as sign-up:
      // a driver asked to send real mail and failing is an error; an explicit
      // console driver is a development choice that prints to the terminal.
      console.error(`[college-email] code was logged, not emailed (driver=${result.driver})`);
      if (env.mail.driver === 'resend') {
        throw Errors.internal(
          'We could not send the verification email. Please try again shortly.',
        );
      }
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

    const perUser = await rateLimit(`emailconfirm:user:${user.id}`, 10, 10);
    const perIp = await rateLimit(`emailconfirm:ip:${ctx.ip ?? 'unknown'}`, 30, 60);
    if (!perUser.allowed || !perIp.allowed) {
      throw Errors.rateLimited('Too many attempts. Please wait a few minutes and try again.');
    }

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

    const outcome = await verifyCode(user.id, code, PURPOSE);

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

    // Re-check ownership at the moment of promotion. Between proposing and
    // proving, somebody else may have taken the address; the unique index would
    // catch it, but a clear message beats a constraint error.
    const owner = await prisma.user.findUnique({
      where: { email: current.pendingEmail },
      select: { id: true },
    });
    if (owner && owner.id !== user.id) {
      await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: null } });
      throw Errors.validation(
        'That address cannot be used for this account. Try another MIT-WPU address, or contact support.',
      );
    }

    const previousEmail = user.email;

    try {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          email: current.pendingEmail,
          emailVerifiedAt: new Date(),
          pendingEmail: null,
        },
      });
    } catch (error) {
      // A racing promotion of the same address. Leave the account as it was.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: null } });
        throw Errors.validation(
          'That address cannot be used for this account. Try another MIT-WPU address, or contact support.',
        );
      }
      throw error;
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
    return NextResponse.json({ ok: true, verified: true, email: current.pendingEmail });
  } catch (error) {
    return toErrorResponse(error);
  }
}
