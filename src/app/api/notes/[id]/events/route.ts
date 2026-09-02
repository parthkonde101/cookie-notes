import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
import { recordEvent } from '@/lib/analytics/events';
import { firstError, noteEventSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Reading telemetry for one note: page turns, time spent, and protection
 * signals (print attempts, screenshot shortcuts, focus loss).
 *
 * The client can only report events for a NoteView row that belongs to it — the
 * row is looked up by id *and* user id, so nobody can write into someone else's
 * reading history.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, session } = await requireApiUser();
    const ctx = contextFromHeaders(request.headers);

    const body = await request.json().catch(() => null);
    const parsed = noteEventSchema.safeParse(body);
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const { type, viewId, page, pageCount, durationMs, signal } = parsed.data;

    const view = viewId
      ? await prisma.noteView.findFirst({
          where: { id: viewId, userId: user.id, noteId: id },
          select: { id: true, maxPage: true },
        })
      : null;

    if (view) {
      await prisma.noteView.update({
        where: { id: view.id },
        data: {
          ...(page ? { lastPage: page, maxPage: Math.max(view.maxPage, page) } : {}),
          ...(pageCount ? { pageCount } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(type === 'close' ? { endedAt: new Date() } : {}),
        },
      });
    }

    if (type === 'close') {
      await recordEvent({
        type: 'NOTE_CLOSED',
        userId: user.id,
        sessionId: session.id,
        noteId: id,
        ctx,
        metadata: { viewId, durationMs, lastPage: page },
      });
    } else if (type === 'page') {
      await recordEvent({
        type: 'NOTE_PAGE_VIEWED',
        userId: user.id,
        sessionId: session.id,
        noteId: id,
        ctx,
        metadata: { viewId, page },
      });
    } else if (type === 'suspicious') {
      await recordEvent({
        type: 'SUSPICIOUS_ACTIVITY',
        userId: user.id,
        sessionId: session.id,
        noteId: id,
        ctx,
        metadata: { viewId, signal: signal ?? 'unknown' },
      });
    }

    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
