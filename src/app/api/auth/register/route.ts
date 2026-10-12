import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { checkPasswordStrength, hashPassword } from '@/lib/auth/password';
import { OTP_PURPOSE, OTP_TTL_MINUTES } from '@/lib/auth/otp';
import { createSession, setRoleHintCookie, setSessionCookie } from '@/lib/auth/session';
import { issueAndSendCode } from '@/lib/auth/send-code';
import { assertWithinLimits, rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { verificationCodeEmail } from '@/lib/mail';
import { firstError, openRegisterSchema, registerSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Creates a student account.
 *
 * With EMAIL_VERIFICATION_REQUIRED off (the deployment default) this is simple
 * registration — see `registerWithoutVerification` at the bottom: any valid
 * email, no code, signed in at once. Everything below it describes the flow used
 * when verification is required, and is unchanged.
 *
 * Creates a student account, pending email verification.
 *
 * Three things about this flow are deliberate.
 *
 * It does NOT sign anybody in. The old version created a session the moment the
 * row was written; now a session exists only after a password is checked at
 * /api/auth/login, and only once the address has been proved. Registration and
 * verification are not authentication events, and neither creates a session.
 *
 * It never touches an account that already exists. An address that is already
 * registered — in any state — is refused with a clear 409 pointing the person to
 * sign in or recover their password, and nothing about that account (password,
 * name, verification state) is read back or changed. The earlier version
 * answered every request identically to avoid revealing which addresses are
 * registered, and quietly replaced the details of an unverified account on
 * re-registration; both are gone, the second because it let anyone who knew an
 * address overwrite the account behind it.
 *
 * It refuses to proceed if mail is not configured. An account that cannot
 * receive its code is an account nobody can ever sign in to, so a console-mode
 * driver fails loudly here rather than minting unreachable rows.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = contextFromHeaders(request.headers);

    if (!env.verification.required) return await registerWithoutVerification(request, ctx);

    // Everything here that sends mail fails CLOSED: if the limiter cannot run,
    // that is not permission to send.
    const limit = await rateLimit(
      `register:${ctx.ip ?? 'unknown'}`,
      env.rateLimit.registerMaxPerHour,
      60,
      { failClosed: true },
    );
    assertWithinLimits(...(limit.unavailable ? [limit] : []));
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
    const perEmail = await rateLimit(`register:email:${email}`, 5, 60, { failClosed: true });
    assertWithinLimits(...(perEmail.unavailable ? [perEmail] : []));
    if (!perEmail.allowed) {
      throw Errors.rateLimited('Too many attempts for this email address. Try again later.');
    }

    // An address that already has an account is refused, plainly, whatever state
    // that account is in — verified, awaiting verification, or an older account
    // that predates verification. Registration only ever CREATES: it never touches
    // the password, name, verification state or any other detail of an account
    // that exists, so knowing someone's address gives no way to alter their
    // account. Someone who abandoned an earlier attempt signs in (which tells them
    // to verify) or uses "Forgot password".
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw Errors.conflict(ALREADY_REGISTERED);

    const passwordHash = await hashPassword(password);

    // Nothing is written to the consent columns. Registration does not show a
    // terms or data-use checkbox, because that wording has not been reviewed,
    // and recording an acceptance nobody was asked for would be inventing one.
    // The columns stay NULL until a reviewed notice exists.
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
    const userId = created.id;
    const displayName = created.name;
    await recordEvent({ type: 'USER_REGISTERED', userId, ctx });
    await recordEvent({ type: 'ACCOUNT_CREATED', userId, ctx, metadata: { via: 'self_signup' } });

    // Issuing supersedes any earlier code for this user, so pressing the button
    // twice leaves exactly one code live.
    await issueAndSendCode({
      userId,
      purpose: OTP_PURPOSE.signUp,
      // The address the code is mailed to is the one it is bound to, so it can
      // only ever verify this account's own address.
      address: email,
      ipAddress: ctx.ip,
      label: 'register',
      failureMessage: 'We could not send your verification email. Please try again shortly.',
      message: (code) => ({ ...verificationCodeEmail(displayName, code, OTP_TTL_MINUTES), to: email }),
    });

    await recordEvent({ type: 'EMAIL_VERIFICATION_SENT', userId, ctx });

    return acceptedResponse();
  } catch (error) {
    // Unique-constraint race: two requests for the same email at once. The loser
    // gets the same clear answer as any other duplicate.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      return toErrorResponse(Errors.conflict(ALREADY_REGISTERED));
    }
    return toErrorResponse(error);
  }
}

/** The answer for a new account whose verification code is on its way. */
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

/**
 * Registration while verification is not required: the original sign-up.
 *
 * Any syntactically valid email, a password that meets the strength rules, and
 * the student is signed in straight away. No code is generated or sent, and
 * nothing is recorded as verified: `emailVerifiedAt` stays null, because an
 * address that was never proved is not a verified one.
 *
 * The network limit and the password rules are the same as the verification
 * flow's. A duplicate address is answered plainly (409) with the way forward,
 * because the student needs to know to log in or recover their password.
 */
async function registerWithoutVerification(request: NextRequest, ctx: ReturnType<typeof contextFromHeaders>) {
  const limit = await rateLimit(`register:${ctx.ip ?? 'unknown'}`, env.rateLimit.registerMaxPerHour, 60);
  if (!limit.allowed) {
    throw Errors.rateLimited('Too many sign-up attempts from this network. Try again later.');
  }

  const body = await request.json().catch(() => null);
  const parsed = openRegisterSchema.safeParse(body);
  if (!parsed.success) throw Errors.validation(firstError(parsed.error));

  const { name, email, password, college, program, semester } = parsed.data;

  const strength = checkPasswordStrength(password, email);
  if (!strength.ok) throw Errors.validation(strength.problems[0]!);

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw Errors.conflict(ALREADY_REGISTERED);

  let user;
  try {
    user = await prisma.user.create({
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
  } catch (error) {
    // Two requests for the same address at once.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      throw Errors.conflict(ALREADY_REGISTERED);
    }
    throw error;
  }

  const { session, token } = await createSession(user.id, ctx);
  await setSessionCookie(token);
  await setRoleHintCookie(user.role);

  await recordEvent({ type: 'USER_REGISTERED', userId: user.id, sessionId: session.id, ctx });
  await recordEvent({ type: 'ACCOUNT_CREATED', userId: user.id, ctx, metadata: { via: 'self_signup' } });
  await recordEvent({ type: 'SESSION_CREATED', userId: user.id, sessionId: session.id, ctx });

  return NextResponse.json({ ok: true, redirectTo: '/' }, { status: 201 });
}

const ALREADY_REGISTERED =
  'An account with this email already exists. Log in instead, or use "Forgot password?" if you cannot remember your password.';
