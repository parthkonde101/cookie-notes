import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { storage } from '@/lib/storage/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves a subject's notebook cover.
 *
 * ## Why this is public where note content is not
 *
 * The catalogue itself is public — anyone may browse semesters, subjects and
 * note titles without an account — so a cover is public information in exactly
 * the way a subject's name is. Note *content* is the protected asset, and it
 * keeps its full chain: session, view token, entitlement re-check, canvas
 * reader. Nothing here touches that path.
 *
 * ## Why the bucket still stays private
 *
 * The browser never learns a storage key and never talks to R2. It asks this
 * route for a subject id; the route looks the key up server-side and streams the
 * bytes. There is no public bucket, no permanent object URL, and no presigned
 * read URL — the same arrangement notes use, minus the per-user authorisation
 * that catalogue imagery does not need.
 *
 * Responses are cacheable and the URL carries a version stamp, so replacing a
 * cover changes the URL and no stale image is ever served.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const subject = await prisma.subject.findFirst({
      where: { id, isArchived: false },
      select: { coverStorageKey: true, coverMimeType: true, coverUpdatedAt: true },
    });

    // 404 rather than a placeholder: the UI draws its own generated cover, and a
    // missing image should not masquerade as a real one.
    if (!subject?.coverStorageKey) throw Errors.notFound('No cover for this subject.');

    const driver = storage();
    const meta = await driver.head(subject.coverStorageKey);
    if (!meta) {
      console.error('[cover] storage object missing for subject', id, subject.coverStorageKey);
      throw Errors.notFound('No cover for this subject.');
    }

    const stream = await driver.getStream(subject.coverStorageKey);

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': subject.coverMimeType || meta.contentType || 'image/jpeg',
        'Content-Length': String(meta.size),
        // The URL is version-stamped by the caller, so a cached copy can only
        // ever be the copy that URL names.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
