import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { checkPasswordStrength, hashPassword } from '@/lib/auth/password';
import { issueCode, OTP_TTL_MINUTES } from '@/lib/auth/otp';
import { rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { sendMail, verificationCodeEmail } from '@/lib/mail';
import { firstError, registerSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Creates a student account, pending email verification.
 *
 * Three things about this flow are deliberate.
 *
 * It does NOT sign anybody in. The old version created a session the moment the
 * row was written; now a session exists only after a password is checked at
 * /api/auth/login, and only once the address has been proved. Registration and
 * verification are not authentication events, and neither creates a session.
 *
 * It answers identically whether or not the address is already registered.
 * The previous 409 "an account with this email already exists" was a free
 * membership oracle for anyone with a list of addresses. Now every well-formed
 * request gets the same 202 and the same wording; what differs is only which
 * email is sent, and that goes to the address's real owner.
 *
 * It refuses to proceed if mail is not configured. An account that cannot
 * receive its code is an account nobody can ever sign in to, so a console-mode
 * driver fails loudly here rather than minting unreachable rows.
 */
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

    // Per-address limit as well as per-network, so one mailbox cannot be
    // flooded from a rotating set of IPs.
    const perEmail = await rateLimit(`register:email:${email}`, 5, 60);
    if (!perEmail.allowed) {
      // Same shape as success: a rate-limit message keyed to an address would
      // itself reveal that the address is interesting.
      return acceptedResponse();
    }

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, status: true, emailVerifiedAt: true, verificationRequired: true },
    });

    // --- already registered, already verified -------------------------------
    // Nothing is created and nothing is changed. The real owner is told that
    // someone tried, which is useful to them; the person who submitted the form
    // sees the same page either way.
    if (existing && (existing.emailVerifiedAt || !existing.verificationRequired)) {
      await sendMail({
        to: email,
        subject: 'Someone tried to sign up with your Cookie Notes email',
        text: [
          `Hi ${existing.name},`,
          '',
          'Someone just tried to create a Cookie Notes account with this email address.',
          'You already have one, so nothing has changed and no new account was made.',
          '',
          'If that was you, sign in instead — or use "Forgot password?" if you cannot get in.',
          'If it was not you, you can safely ignore this email.',
          '',
          '—',
          'Cookie Notes · Baked for exams.',
        ].join('\n'),
      }).catch((error) => {
        console.error('[register] duplicate-notice mail failed', error);
      });
      return acceptedResponse();
    }

    const passwordHash = await hashPassword(password);

    // Nothing is written to the consent columns. Registration does not show a
    // terms or data-use checkbox, because that wording has not been reviewed,
    // and recording an acceptance nobody was asked for would be inventing one.
    // The columns stay NULL until a reviewed notice exists.

    let userId: string;
    let displayName: string;

    if (existing) {
      // --- registered but never verified ------------------------------------
      // No account was ever usable here, so re-registering replaces the details
      // and re-sends a code rather than erroring. This is what stops an
      // abandoned attempt from permanently squatting a real student's address.
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: {
          name,
          passwordHash,
          college: college || null,
          program: program || null,
          semester: semester ?? null,
        },
        select: { id: true, name: true },
      });
      userId = updated.id;
      displayName = updated.name;
    } else {
      const created = await prisma.user.create({
        data: {
          name,
          email,
          passwordHash,
          role: 'STUDENT',
          status: 'ACTIVE',
          // The account exists but cannot be signed in to until the code is
          // entered. Enforced in the login route, server-side.
          verificationRequired: true,
          emailVerifiedAt: null,
          college: college || null,
          program: program || null,
          semester: semester ?? null,
        },
        select: { id: true, name: true },
      });
      userId = created.id;
      displayName = created.name;
      await recordEvent({ type: 'USER_REGISTERED', userId, ctx });
      await recordEvent({ type: 'ACCOUNT_CREATED', userId, ctx, metadata: { via: 'self_signup' } });
    }

    // Issuing supersedes any earlier code for this user, so pressing the button
    // twice leaves exactly one code live.
    const { code } = await issueCode(userId, ctx.ip);

    const result = await sendMail({
      ...verificationCodeEmail(displayName, code, OTP_TTL_MINUTES),
      to: email,
    });

    if (!result.delivered) {
      // The code went to the server log rather than an inbox.
      //
      // Which of those two situations this is matters. Asking for real mail and
      // not getting it is an accident — a missing key — and it mints accounts
      // nobody can ever sign in to, so it fails loudly. Explicitly choosing
      // MAIL_DRIVER=console is a deliberate choice that prints the code to the
      // terminal, which is how local development and the flow tests work; that
      // is allowed to proceed, and `productionConfigWarnings` already shouts at
      // boot if someone has left it that way in production.
      const misconfigured = env.mail.driver === 'resend';
      console.error(
        `[register] verification code was logged, not emailed (driver=${result.driver})`,
      );
      if (misconfigured) {
        throw Errors.internal(
          'We could not send your verification email. Please try again shortly.',
        );
      }
    }

    await recordEvent({ type: 'EMAIL_VERIFICATION_SENT', userId, ctx });

    return acceptedResponse();
  } catch (error) {
    // Unique-constraint race: two requests for the same email at once.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      // Email collision: answer exactly as a successful submission would, so
      // the race cannot be used to learn that an address is taken.
      return acceptedResponse();
    }
    return toErrorResponse(error);
  }
}

/**
 * The single answer this endpoint gives to any well-formed submission.
 *
 * Identical for a brand-new account, a re-registration of an unverified one,
 * and an address that already belongs to somebody — so the response cannot be
 * used to test whether an email is registered.
 */
function acceptedResponse() {
  return NextResponse.json(
    {
      ok: true,
      status: 'verification_sent',
      message: 'Check your inbox for a 6-digit verification code.',
      expiresInMinutes: OTP_TTL_MINUTES,
    },
    { status: 202 },
  );
}
