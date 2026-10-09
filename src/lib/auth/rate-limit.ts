import 'server-only';
import { prisma } from '@/lib/prisma';
import { Errors } from '@/lib/errors';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  /**
   * The limiter itself could not run (the database failed). Only ever set when
   * the caller asked to fail closed: permission could not be established, which
   * is different from "too many attempts".
   */
  unavailable?: boolean;
}

export interface RateLimitOptions {
  /**
   * What to do when the limiter cannot run.
   *
   * By default it fails OPEN, so a limiter fault never takes the app down — the
   * right trade for ordinary endpoints. Anything that sends mail or guards a
   * secret passes `failClosed: true`: if permission cannot be established, the
   * answer is no, so a database fault is not a way round the limit.
   */
  failClosed?: boolean;
}

/**
 * Fixed-window rate limiter backed by Postgres.
 *
 * Database-backed on purpose: an in-memory counter is useless on serverless
 * platforms where every request may hit a fresh instance.
 *
 * The count, the window and the decision all come from ONE statement. The earlier
 * version read the row and then wrote it, so a burst of simultaneous requests
 * could all read a count below the limit and all pass, and concurrent first
 * requests could reset the counter instead of adding to it. Here the upsert
 * increments under the row lock Postgres takes for the conflict, and the clock is
 * the database's, so every instance agrees on when a window ends.
 *
 * Every attempt is counted, including refused ones; a refused attempt does not
 * extend the window.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMinutes: number,
  options: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const windowSeconds = Math.round(windowMinutes * 60);

  try {
    const rows = await prisma.$queryRaw<{ count: number; retry_after: number }[]>`
      INSERT INTO "rate_limits" AS r ("key", "count", "windowStart", "expiresAt")
      VALUES (
        ${key}, 1,
        (now() AT TIME ZONE 'utc'),
        (now() AT TIME ZONE 'utc') + make_interval(secs => ${windowSeconds}::double precision)
      )
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN r."expiresAt" <= (now() AT TIME ZONE 'utc') THEN 1 ELSE r."count" + 1 END,
        "windowStart" = CASE WHEN r."expiresAt" <= (now() AT TIME ZONE 'utc')
                             THEN (now() AT TIME ZONE 'utc') ELSE r."windowStart" END,
        "expiresAt" = CASE WHEN r."expiresAt" <= (now() AT TIME ZONE 'utc')
                           THEN (now() AT TIME ZONE 'utc') + make_interval(secs => ${windowSeconds}::double precision)
                           ELSE r."expiresAt" END
      RETURNING r."count" AS "count",
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM (r."expiresAt" - (now() AT TIME ZONE 'utc')))))::int AS "retry_after"
    `;
    const { count, retry_after: retryAfter } = rows[0];

    if (count > limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), retryAfterSeconds: 0 };
  } catch (error) {
    console.error('[rate-limit] failed', error instanceof Error ? error.name : 'unknown error');
    if (options.failClosed) {
      return { allowed: false, remaining: 0, retryAfterSeconds: 30, unavailable: true };
    }
    // Never let the limiter take an ordinary endpoint down; fail open.
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}

/**
 * Turns limiter results into the right refusal: "too many attempts" when the
 * limit was reached, and a plain "try again shortly" when the limiter could not
 * run — the two are not the same thing, and the second must not read as a quota.
 */
export function assertWithinLimits(...results: RateLimitResult[]): void {
  const refused = results.find((result) => !result.allowed);
  if (!refused) return;
  if (refused.unavailable) {
    throw Errors.internal('This is temporarily unavailable. Please try again shortly.');
  }
  throw Errors.rateLimited('Too many attempts. Please wait a few minutes and try again.');
}

/** Called opportunistically so the table does not grow forever. */
export async function pruneRateLimits(): Promise<void> {
  try {
    await prisma.rateLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch {
    /* best effort */
  }
}
