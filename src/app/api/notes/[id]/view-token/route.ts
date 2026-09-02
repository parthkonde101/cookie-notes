import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { toErrorResponse, Errors } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
import { assertNoteAccess } from '@/lib/access/entitlements';
import { createViewToken } from '@/lib/tokens';
import { recordEvent } from '@/lib/analytics/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Opens a reading session for a note.
 *
 * Returns a token that is valid for a few minutes and is bound to this user and
 * this session. The content endpoint verifies it *and* re-runs the entitlement
 * check, so the token is a convenience, never the authority.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, session } = await requireApiUser();
    const ctx = contextFromHeaders(request.headers);

    await assertNoteAccess(user.id, user.role, id);

    const note = await prisma.note.findUnique({
      where: { id },
      select: { id: true, title: true, pageCount: true, subjectId: true, fileSize: true },
    });
    if (!note) throw Errors.notFound('This note is not available on your account.');

    const view = await prisma.noteView.create({
      data: { noteId: note.id, userId: user.id, sessionId: session.id },
      select: { id: true },
    });

    await prisma.note.update({
      where: { id: note.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    });

    await recordEvent({
      type: 'NOTE_OPENED',
      userId: user.id,
      sessionId: session.id,
      noteId: note.id,
      subjectId: note.subjectId,
      ctx,
      metadata: { viewId: view.id },
    });

    const { token, expiresAt } = createViewToken(note.id, user.id, session.id);

    return NextResponse.json(
      {
        ok: true,
        viewId: view.id,
        token,
        expiresAt: expiresAt.toISOString(),
        contentUrl: `/api/notes/${note.id}/content?t=${encodeURIComponent(token)}`,
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
