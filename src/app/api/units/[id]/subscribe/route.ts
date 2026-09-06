import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
import { recordEvent } from '@/lib/analytics/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Notify me" for a unit whose notes are still being baked.
 *
 * The subscription is always the *caller's own*: the user id comes from the
 * session, never from the request body, so there is no shape of request that
 * lets one student subscribe, unsubscribe or enumerate another. The unique
 * constraint on (userId, unitId) makes a repeated POST idempotent rather than a
 * way to queue duplicate emails.
 *
 * This grants nothing. It is not an entitlement, it does not touch note access,
 * and being subscribed never makes content readable — it only means an email is
 * sent when the unit is published.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, session } = await requireApiUser();
    const ctx = contextFromHeaders(request.headers);

    const unit = await requireSubscribableUnit(id);

    // Idempotent: subscribing twice is the same as subscribing once.
    await prisma.unitNotificationSubscription.upsert({
      where: { userId_unitId: { userId: user.id, unitId: unit.id } },
      create: { userId: user.id, unitId: unit.id },
      update: {},
    });

    await recordEvent({
      type: 'UNIT_SUBSCRIBED',
      userId: user.id,
      sessionId: session.id,
      subjectId: unit.subjectId,
      ctx,
      metadata: { unitId: unit.id },
    });

    return NextResponse.json(
      { ok: true, subscribed: true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Unsubscribes the caller. Removing a subscription that is not there is fine. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, session } = await requireApiUser();
    const ctx = contextFromHeaders(request.headers);

    const unit = await prisma.unit.findUnique({
      where: { id },
      select: { id: true, subjectId: true },
    });
    if (!unit) throw Errors.notFound('That unit no longer exists.');

    // Scoped to this user: a caller can only ever delete their own row.
    await prisma.unitNotificationSubscription.deleteMany({
      where: { userId: user.id, unitId: unit.id },
    });

    await recordEvent({
      type: 'UNIT_UNSUBSCRIBED',
      userId: user.id,
      sessionId: session.id,
      subjectId: unit.subjectId,
      ctx,
      metadata: { unitId: unit.id },
    });

    return NextResponse.json(
      { ok: true, subscribed: false },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * A unit worth subscribing to: it exists, it is public catalogue material, and
 * it has no PDF yet. Once the notes are up there is nothing to wait for, so the
 * endpoint declines rather than collecting a subscription that can never fire.
 */
async function requireSubscribableUnit(id: string) {
  const unit = await prisma.unit.findUnique({
    where: { id },
    select: {
      id: true,
      subjectId: true,
      beingBaked: true,
      subject: { select: { isArchived: true } },
      notes: { select: { id: true }, take: 1 },
    },
  });

  if (!unit || unit.subject.isArchived) throw Errors.notFound('That unit no longer exists.');
  if (unit.notes.length > 0) {
    throw Errors.validation('These notes are already available.');
  }
  return unit;
}
