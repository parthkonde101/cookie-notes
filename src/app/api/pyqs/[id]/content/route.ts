import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiUser } from '@/lib/auth/guards';
import { checkPyqAccess } from '@/lib/access/entitlements';
import { pyqTokenSubject, verifyViewToken } from '@/lib/tokens';
import { storage } from '@/lib/storage/index';
import { recordEvent } from '@/lib/analytics/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The only path by which a previous-year paper's bytes reach a browser.
 *
 * The same four independent checks the note content route runs, in the same
 * order, against the paper's own authorisation rule:
 *   1. a valid, live session cookie (not just a token in the URL)
 *   2. a short-lived view token whose signature, expiry, user, session AND
 *      document namespace match
 *   3. a fresh entitlement lookup — so a revoked grant blocks the very next read
 *   4. the paper still exists on a visible subject
 *
 * Nothing here is cacheable and no storage URL is ever exposed.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = contextFromHeaders(request.headers);

    // 1. Session cookie — a leaked link is worthless without it.
    const { user, session } = await requireApiUser();

    // 2. Short-lived signed token, bound to this user, this session, and a paper
    //    rather than a note.
    const token = verifyViewToken(request.nextUrl.searchParams.get('t'));
    if (
      !token ||
      token.n !== pyqTokenSubject(id) ||
      token.u !== user.id ||
      token.s !== session.id
    ) {
      await recordEvent({
        type: 'SUSPICIOUS_ACTIVITY',
        userId: user.id,
        sessionId: session.id,
        ctx,
        metadata: { signal: 'invalid_view_token', pyqId: id },
      });
      throw Errors.forbidden('This view link is no longer valid. Reopen the paper.');
    }

    // 3. Entitlements, re-checked from the database right now.
    const decision = await checkPyqAccess(user.id, user.role, id);
    if (!decision.allowed) {
      await recordEvent({
        type: 'SUSPICIOUS_ACTIVITY',
        userId: user.id,
        sessionId: session.id,
        ctx,
        metadata: { signal: 'content_request_without_access', reason: decision.reason, pyqId: id },
      });
      throw Errors.notFound('This paper is not available on your account.');
    }

    // 4. The paper itself.
    const pyq = await prisma.pyq.findUnique({
      where: { id },
      select: { id: true, storageKey: true, mimeType: true },
    });
    if (!pyq) throw Errors.notFound('This paper is not available on your account.');

    const driver = storage();
    const meta = await driver.head(pyq.storageKey);
    if (!meta) {
      console.error('[content] storage object missing for pyq', pyq.id, pyq.storageKey);
      throw Errors.notFound('This file is temporarily unavailable. Please try again later.');
    }

    const stream = await driver.getStream(pyq.storageKey);

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': pyq.mimeType || 'application/pdf',
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
