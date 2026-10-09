import 'server-only';
import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';

/**
 * One-time codes for proving control of an email address.
 *
 * What a verified code means, precisely: whoever entered it can read mail sent
 * to that address. It says nothing about who they are, and in particular it
 * does not corroborate the PRN they typed on the form. Nothing in this module
 * should ever be described as identity verification.
 *
 * The plaintext code exists in exactly one place — the return value of
 * `issueCode`, long enough for the caller to put it in an email. It is never
 * logged, never stored and no API response contains it.
 *
 * ## What a stored code is bound to
 *
 * Only a keyed hash is stored: HMAC-SHA256 over the code together with the
 * account, the purpose and the exact address the code was sent to. So a code is
 * good for one account, one purpose and ONE ADDRESS, and nothing else:
 *
 *  - a code sent to B cannot authorise a change to C, even if C ends up recorded
 *    as the proposal by a request that raced with the one that sent B's code;
 *  - a sign-up code cannot move an address, and neither can verify another
 *    account's mailbox;
 *  - the database alone cannot be used to recover a code by hashing the million
 *    six-digit possibilities, because the key is not in the database.
 *
 * The key is derived from `AUTH_SECRET` and is never used for anything else.
 * There is deliberately no fallback: without the secret, issuing and verifying
 * both refuse to run, rather than quietly storing something weaker.
 */

/** Digits in a code. Six is the familiar shape; attempt-limiting is what makes it safe. */
const CODE_DIGITS = 6;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
/** How long a student must wait before asking for another code. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/**
 * What a code was issued FOR. Codes of one purpose can never be spent on another,
 * so a sign-up code cannot move an address and an address-change code cannot
 * verify the current one.
 */
export const OTP_PURPOSE = {
  signUp: 'email_verification',
  /** Moving an account to a different (college) address. */
  emailChange: 'email_change',
  /** Proving control of the address the account already has. */
  currentEmail: 'current_email',
} as const;

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

/** The destination exactly as it is compared and bound: trimmed and lower-cased. */
export function canonicalAddress(address: string): string {
  return address.trim().toLowerCase();
}

let cachedKey: { secret: string; key: Buffer } | null = null;

/**
 * The HMAC key, derived (HKDF) from AUTH_SECRET so the secret itself never keys
 * anything directly. Throws when the secret is missing or too short — callers
 * must not catch that and carry on.
 */
function otpKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('One-time codes are unavailable: AUTH_SECRET is missing or too short.');
  }
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = Buffer.from(hkdfSync('sha256', secret, 'cookie-notes', 'otp-hmac/v1', 32));
  cachedKey = { secret, key };
  return key;
}

export interface CodeBinding {
  userId: string;
  purpose: string;
  /** The address the code is sent to / must have been sent to. */
  address: string;
}

/**
 * The value stored for a code. Every field is length-prefixed so no two
 * different (account, purpose, address, code) tuples can serialise alike.
 */
export function hashCode(code: string, binding: CodeBinding): string {
  const fields = ['otp/v1', binding.userId, binding.purpose, canonicalAddress(binding.address), code];
  const message = fields.map((field) => `${Buffer.byteLength(field)}:${field}`).join('|');
  return createHmac('sha256', otpKey()).update(message).digest('hex');
}

/** Constant-time compare, so a wrong code leaks nothing through timing. */
function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export type OtpTransaction = Prisma.TransactionClient;

export interface IssueOptions extends CodeBinding {
  ipAddress: string | null;
  /**
   * Refuse to issue — and say how long to wait — if a code for this account and
   * purpose was issued less than this many seconds ago. Checked INSIDE the lock
   * that serialises issuing, so two simultaneous requests cannot both pass it.
   */
  cooldownSeconds?: number;
  /**
   * Runs in the same transaction as the new code, and only when one is issued.
   * It is how the address-change flow records the proposed address together
   * with the code that proves it, so the two can never disagree.
   *
   * It runs after the code has been written, so that this transaction locks rows
   * in the same order as `verifyCode`'s `onClaim` (token row, then user row).
   */
  inTransaction?: (tx: OtpTransaction) => Promise<void>;
}

export interface IssuedCode {
  status: 'issued';
  code: string;
  expiresAt: Date;
  /** For `invalidateCode`: lets a caller retire exactly this code and no other. */
  tokenId: string;
}

export interface CodeCooldown {
  status: 'cooldown';
  retryAfterSeconds: number;
  /** A code is still usable (it was sent); false when the last one was burned or failed to send. */
  live: boolean;
}

/**
 * Issues a fresh code for a user, invalidating any earlier one.
 *
 * Issuing is serialised per (account, purpose) by a transaction-scoped advisory
 * lock, so concurrent requests queue instead of interleaving. That is what keeps
 * "at most one live code" true: without it, simultaneous requests each find
 * nothing to supersede and each leave their own code live — and any older live
 * code becomes the target again the moment the newest is spent. The lock is held
 * only for the few statements below; the email is sent after it is released.
 *
 * The cooldown is measured against the most recent code of this purpose whether
 * or not it is still live. A code that was locked out, expired or failed to send
 * still counts, so burning a code never opens a way round the cooldown.
 *
 * Returns the plaintext for the caller to email. It must not be logged, stored,
 * or returned to the browser.
 */
export async function issueCode(options: IssueOptions & { cooldownSeconds?: 0 }): Promise<IssuedCode>;
export async function issueCode(options: IssueOptions): Promise<IssuedCode | CodeCooldown>;
export async function issueCode(options: IssueOptions): Promise<IssuedCode | CodeCooldown> {
  const { userId, purpose, ipAddress, cooldownSeconds = 0, inTransaction } = options;

  // Both of these throw if the secret is missing — before any row is touched.
  const code = generateCode();
  const codeHash = hashCode(code, options);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`otp:${userId}:${purpose}`}, 0))`;

    if (cooldownSeconds > 0) {
      const latest = await tx.emailVerificationToken.findFirst({
        where: { userId, purpose },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, consumedAt: true, expiresAt: true },
      });
      if (latest) {
        const ageSeconds = (Date.now() - latest.createdAt.getTime()) / 1000;
        if (ageSeconds < cooldownSeconds) {
          return {
            status: 'cooldown',
            retryAfterSeconds: Math.max(1, Math.ceil(cooldownSeconds - ageSeconds)),
            live: latest.consumedAt === null && latest.expiresAt > new Date(),
          } satisfies CodeCooldown;
        }
      }
    }

    await tx.emailVerificationToken.updateMany({
      where: { userId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const created = await tx.emailVerificationToken.create({
      data: { userId, purpose, codeHash, expiresAt, ipAddress },
      select: { id: true },
    });

    // The caller's own writes come LAST, and that order is load-bearing. Spending a
    // code (verifyCode's `onClaim`) locks the token row first and then the user
    // row; if issuing locked the user row first, a confirmation and a new proposal
    // arriving together would each hold what the other needs, and Postgres would
    // abort one of them as a deadlock. Locking the token row, then the user row,
    // on both sides makes that impossible. Everything is still one transaction, so
    // if this step throws, the supersede and the new code roll back with it.
    if (inTransaction) await inTransaction(tx);

    return { status: 'issued', code, expiresAt, tokenId: created.id } satisfies IssuedCode;
  });

  if (result.status === 'issued') {
    // Housekeeping, done opportunistically so the table cannot grow forever
    // without needing a scheduled job. Best effort: a failure here must never
    // stop a student signing up.
    void prisma.emailVerificationToken
      .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
      .catch(() => undefined);
  }
  return result;
}

/**
 * Retires one specific code — used when it could not be delivered.
 *
 * It matches the code by id and only while it is still unspent, so it can never
 * touch a newer code issued by a request that got in after this one, and it does
 * nothing to a code that has already been used.
 */
export async function invalidateCode(tokenId: string): Promise<void> {
  await prisma.emailVerificationToken.updateMany({
    where: { id: tokenId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

/** When the live code for this user was issued, or null if there is none. */
export async function lastIssuedAt(
  userId: string,
  purpose: string = OTP_PURPOSE.signUp,
): Promise<Date | null> {
  const row = await prisma.emailVerificationToken.findFirst({
    where: { userId, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

export interface VerifyOptions extends CodeBinding {
  code: string;
  /**
   * Runs in the SAME transaction that spends the code, after the claim succeeds.
   * If it throws, the transaction rolls back and the code is NOT spent — so the
   * effect (marking an account verified, moving an address) and the single use
   * of the code happen together or not at all.
   */
  onClaim?: (tx: OtpTransaction) => Promise<void>;
}

/**
 * Checks a code and consumes it on success.
 *
 * The code must have been issued for exactly this account, purpose and address;
 * a code for any other address simply does not match, and costs an attempt like
 * any other wrong guess.
 *
 * Every failure path costs an attempt, and the fifth failure burns the code
 * rather than merely rejecting the guess — otherwise a six-digit secret is one
 * patient script away from being no secret at all. Expiry is checked before
 * the comparison so a stale code can never be spent.
 *
 * Both limits hold under parallel requests, not just sequential ones. A plain
 * "read the row, compare, write the result" lets any number of simultaneous
 * requests all read the same state: a hundred guesses could each see
 * `attempts = 0`, and two correct submissions could each find an unconsumed
 * code. So the two decisions are made by the database, as conditional updates:
 *
 *  - an attempt is RESERVED before the code is compared, by an update that only
 *    matches while `attempts < OTP_MAX_ATTEMPTS` — so at most that many guesses
 *    are ever evaluated, however they arrive;
 *  - success is CLAIMED by an update that only matches while `consumedAt` is
 *    still null — so of any number of correct submissions exactly one wins.
 */
export async function verifyCode(options: VerifyOptions): Promise<VerifyOutcome> {
  const { userId, purpose, code, onClaim } = options;

  const token = await prisma.emailVerificationToken.findFirst({
    where: { userId, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!token) return { ok: false, reason: 'no_code' };

  const burn = () =>
    prisma.emailVerificationToken.updateMany({
      where: { id: token.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

  if (token.expiresAt <= new Date()) {
    await burn();
    return { ok: false, reason: 'expired' };
  }

  // Reserve an attempt, atomically, and learn which attempt this one is. The
  // statement matches nothing once the allowance is spent or the code has been
  // consumed by a concurrent request — and says so by returning no row, rather
  // than by failing.
  const reserved = await prisma.$queryRaw<{ attempts: number }[]>`
    UPDATE "email_verification_tokens"
    SET "attempts" = "attempts" + 1
    WHERE "id" = ${token.id}
      AND "consumedAt" IS NULL
      AND "attempts" < ${OTP_MAX_ATTEMPTS}
    RETURNING "attempts"
  `;
  if (reserved.length !== 1) {
    const current = await prisma.emailVerificationToken.findUnique({
      where: { id: token.id },
      select: { consumedAt: true },
    });
    // Consumed while we were reading (a concurrent success or a newer code).
    if (!current || current.consumedAt) return { ok: false, reason: 'no_code' };
    await burn();
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (!hashesMatch(token.codeHash, hashCode(code, options))) {
    if (reserved[0].attempts >= OTP_MAX_ATTEMPTS) {
      await burn();
      return { ok: false, reason: 'too_many_attempts' };
    }
    return { ok: false, reason: 'mismatch' };
  }

  // Single-use: claimed in the same statement that checks it is still unspent,
  // so a replay — or a simultaneous twin of this request — finds nothing.
  if (!onClaim) {
    const claimed = await burn();
    if (claimed.count !== 1) return { ok: false, reason: 'no_code' };
    return { ok: true };
  }

  return prisma.$transaction(async (tx): Promise<VerifyOutcome> => {
    const claimed = await tx.emailVerificationToken.updateMany({
      where: { id: token.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) return { ok: false, reason: 'no_code' };
    await onClaim(tx);
    return { ok: true };
  });
}
