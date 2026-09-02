import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
import { checkNoteAccess } from '@/lib/access/entitlements';
import { verifyViewToken } from '@/lib/tokens';
import { storage } from '@/lib/storage/index';
import { recordEvent } from '@/lib/analytics/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The only path by which note bytes ever reach a browser.
 *
 * Four independent checks run on every single request:
 *   1. a valid, live session cookie (not just a token in the URL)
 *   2. a short-lived view token whose signature, expiry, user AND session match
 *   3. a fresh entitlement lookup — so a revoked grant blocks the very next read
 *   4. the note still exists and is published
 *
 * Nothing here is cacheable and no storage URL is ever exposed.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = contextFromHeaders(request.headers);

    // 1. Session cookie — a leaked link is worthless without it.
    const { user, session } = await requireApiUser();

    // 2. Short-lived signed token, bound to this user and this session.
    const token = verifyViewToken(request.nextUrl.searchParams.get('t'));
    if (!token || token.n !== id || token.u !== user.id || token.s !== session.id) {
      await recordEvent({
        type: 'SUSPICIOUS_ACTIVITY',
        userId: user.id,
        sessionId: session.id,
        noteId: id,
        ctx,
        metadata: { signal: 'invalid_view_token' },
      });
      throw Errors.forbidden('This view link is no longer valid. Reopen the note.');
    }

    // 3. Entitlements, re-checked from the database right now.
    const decision = await checkNoteAccess(user.id, user.role, id);
    if (!decision.allowed) {
      await recordEvent({
        type: 'SUSPICIOUS_ACTIVITY',
        userId: user.id,
        sessionId: session.id,
        noteId: id,
        ctx,
        metadata: { signal: 'content_request_without_access', reason: decision.reason },
      });
      throw Errors.notFound('This note is not available on your account.');
    }

    // 4. The note itself.
    const note = await prisma.note.findUnique({
      where: { id },
      select: { id: true, storageKey: true, mimeType: true, fileSize: true, status: true },
    });
    if (!note) throw Errors.notFound('This note is not available on your account.');
    if (note.status !== 'PUBLISHED' && user.role !== 'ADMIN') {
      throw Errors.notFound('This note is not available on your account.');
    }

    const driver = storage();
    const meta = await driver.head(note.storageKey);
    if (!meta) {
      console.error('[content] storage object missing for note', note.id, note.storageKey);
      throw Errors.notFound('This file is temporarily unavailable. Please try again later.');
    }

    const stream = await driver.getStream(note.storageKey);

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': note.mimeType || 'application/pdf',
        'Content-Length': String(meta.size),
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'none',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
