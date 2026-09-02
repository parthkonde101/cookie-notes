import 'server-only';
import { prisma } from '@/lib/prisma';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter backed by Postgres.
 *
 * Database-backed on purpose: an in-memory counter is useless on serverless
 * platforms where every request may hit a fresh instance.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMinutes: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const windowMs = windowMinutes * 60 * 1000;

  try {
    const existing = await prisma.rateLimit.findUnique({ where: { key } });

    if (!existing || existing.expiresAt <= now) {
      await prisma.rateLimit.upsert({
        where: { key },
        create: { key, count: 1, windowStart: now, expiresAt: new Date(now.getTime() + windowMs) },
        update: { count: 1, windowStart: now, expiresAt: new Date(now.getTime() + windowMs) },
      });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.expiresAt.getTime() - now.getTime()) / 1000)),
      };
    }

    const updated = await prisma.rateLimit.update({
      where: { key },
      data: { count: { increment: 1 } },
    });

    return {
      allowed: true,
      remaining: Math.max(0, limit - updated.count),
      retryAfterSeconds: 0,
    };
  } catch (error) {
    // Never let the limiter take the app down; log and fail open.
    console.error('[rate-limit] failed', error);
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}

/** Called opportunistically so the table does not grow forever. */
export async function pruneRateLimits(): Promise<void> {
  try {
    await prisma.rateLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch {
    /* best effort */
  }
}
