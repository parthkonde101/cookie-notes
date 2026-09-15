import 'server-only';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';

/**
 * One-time codes for proving control of an email address.
 *
 * What a verified code means, precisely: whoever entered it can read mail sent
 * to that address. It says nothing about who they are, and in particular it
 * does not corroborate the PRN they typed on the form. Nothing in this module
 * should ever be described as identity verification.
 *
 * The plaintext code exists in exactly one place — the return value of
 * `issueCode`, long enough for the caller to put it in an email. Only its
 * SHA-256 hash is stored, it is never logged, and no API response contains it.
 */

/** Digits in a code. Six is the familiar shape; attempt-limiting is what makes it safe. */
const CODE_DIGITS = 6;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
/** How long a student must wait before asking for another code. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'too_many_attempts' | 'mismatch' };

/**
 * A uniformly random numeric code.
 *
 * `randomInt` is used rather than `randomBytes(n) % 10**digits`: the modulo
 * form is biased toward low values whenever the byte range is not an exact
 * multiple of the modulus, which quietly shrinks the search space. `randomInt`
 * rejects and resamples instead, so every code is equally likely.
 */
export function generateCode(): string {
  const max = 10 ** CODE_DIGITS;
  return String(randomInt(0, max)).padStart(CODE_DIGITS, '0');
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Constant-time compare, so a wrong code leaks nothing through timing. */
function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Issues a fresh code for a user, invalidating any earlier one.
 *
 * Superseding previous codes is what keeps "resend" safe: at most one code is
 * ever live per user, so a student cannot accumulate a pool of valid codes by
 * pressing the button repeatedly, and an old code that was already read by
 * someone else stops working the moment a new one is asked for.
 *
 * Returns the plaintext for the caller to email. It must not be logged, stored,
 * or returned to the browser.
 */
export async function issueCode(
  userId: string,
  ipAddress: string | null,
  purpose = 'email_verification',
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await prisma.$transaction([
    prisma.emailVerificationToken.updateMany({
      where: { userId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
    prisma.emailVerificationToken.create({
      data: { userId, purpose, codeHash: hashCode(code), expiresAt, ipAddress },
    }),
  ]);

  // Housekeeping, done opportunistically so the table cannot grow forever
  // without needing a scheduled job. Best effort: a failure here must never
  // stop a student signing up.
  void prisma.emailVerificationToken
    .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
    .catch(() => undefined);

  return { code, expiresAt };
}

/** When the live code for this user was issued, or null if there is none. */
export async function lastIssuedAt(
  userId: string,
  purpose = 'email_verification',
): Promise<Date | null> {
  const row = await prisma.emailVerificationToken.findFirst({
    where: { userId, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

/**
 * Checks a code and consumes it on success.
 *
 * Every failure path costs an attempt, and the fifth failure burns the code
 * rather than merely rejecting the guess — otherwise a six-digit secret is one
 * patient script away from being no secret at all. Expiry is checked before
 * the comparison so a stale code can never be spent.
 */
export async function verifyCode(
  userId: string,
  code: string,
  purpose = 'email_verification',
): Promise<VerifyOutcome> {
  const token = await prisma.emailVerificationToken.findFirst({
    where: { userId, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!token) return { ok: false, reason: 'no_code' };

  if (token.expiresAt <= new Date()) {
    await prisma.emailVerificationToken.update({
      where: { id: token.id },
      data: { consumedAt: new Date() },
    });
    return { ok: false, reason: 'expired' };
  }

  if (token.attempts >= OTP_MAX_ATTEMPTS) {
    await prisma.emailVerificationToken.update({
      where: { id: token.id },
      data: { consumedAt: new Date() },
    });
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (!hashesMatch(token.codeHash, hashCode(code))) {
    const updated = await prisma.emailVerificationToken.update({
      where: { id: token.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    if (updated.attempts >= OTP_MAX_ATTEMPTS) {
      await prisma.emailVerificationToken.update({
        where: { id: token.id },
        data: { consumedAt: new Date() },
      });
      return { ok: false, reason: 'too_many_attempts' };
    }
    return { ok: false, reason: 'mismatch' };
  }

  // Single-use: consumed the moment it succeeds, so a replay finds nothing.
  await prisma.emailVerificationToken.update({
    where: { id: token.id },
    data: { consumedAt: new Date() },
  });
  return { ok: true };
}
