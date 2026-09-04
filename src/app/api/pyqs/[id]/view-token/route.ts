import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { toErrorResponse, Errors } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
import { assertPyqAccess } from '@/lib/access/entitlements';
import { createViewToken, pyqTokenSubject } from '@/lib/tokens';
import { recordEvent } from '@/lib/analytics/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Opens a reading session for a previous-year paper.
 *
 * Deliberately identical in shape to the note equivalent: the same short-lived
 * token bound to this user and this session, and the same promise that the
 * content route re-checks everything from the database rather than trusting the
 * token. The only difference is the subject namespace inside the token, which
 * stops a note token being replayed against a paper or the reverse.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, session } = await requireApiUser();
    const ctx = contextFromHeaders(request.headers);

    await assertPyqAccess(user.id, user.role, id);

    const pyq = await prisma.pyq.findUnique({
      where: { id },
      select: { id: true, year: true, subjectId: true, pageCount: true },
    });
    if (!pyq) throw Errors.notFound('This paper is not available on your account.');

    await prisma.pyq.update({
      where: { id: pyq.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    });

    await recordEvent({
      type: 'PYQ_OPENED',
      userId: user.id,
      sessionId: session.id,
      subjectId: pyq.subjectId,
      ctx,
      metadata: { pyqId: pyq.id, year: pyq.year },
    });

    const { token, expiresAt } = createViewToken(pyqTokenSubject(pyq.id), user.id, session.id);

    return NextResponse.json(
      {
        ok: true,
        // The reader reports progress against a view id; papers are not tracked
        // per-reading the way notes are, so there is nothing to correlate.
        viewId: null,
        token,
        expiresAt: expiresAt.toISOString(),
        contentUrl: `/api/pyqs/${pyq.id}/content?t=${encodeURIComponent(token)}`,
        watermark: {
          email: user.email,
          name: user.name,
          sessionRef: session.id.slice(-8).toUpperCase(),
          issuedAt: new Date().toISOString(),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
