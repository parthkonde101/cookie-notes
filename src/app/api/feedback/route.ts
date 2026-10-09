import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
import { rateLimit } from '@/lib/auth/rate-limit';
import { recordEvent } from '@/lib/analytics/events';
import { feedbackSchema, firstError } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A testimonial, stored against the caller's own account.
 *
 * `userId` comes from the session, never from the request body — the same
 * rule `/api/units/[id]/subscribe` follows — so there is no shape of request
 * that lets one student submit on behalf of another. Public display consent
 * is recorded here but decides nothing by itself: featuring still requires an
 * admin to review the testimonial first.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, session } = await requireApiUser();
    const ctx = contextFromHeaders(request.headers);

    const limit = await rateLimit(`feedback:${user.id}`, 5, 60);
    if (!limit.allowed) throw Errors.rateLimited();

    const body = await request.json().catch(() => null);
    const parsed = feedbackSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const feedback = await prisma.feedback.create({
      data: {
        userId: user.id,
        message: parsed.data.message,
        publicConsent: parsed.data.publicConsent,
      },
      select: { id: true },
    });

    await recordEvent({
      type: 'FEEDBACK_SUBMITTED',
      userId: user.id,
      sessionId: session.id,
      ctx,
      metadata: { publicConsent: parsed.data.publicConsent },
    });

    return NextResponse.json(
      { ok: true, id: feedback.id },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
