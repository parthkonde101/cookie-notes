import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { storage } from '@/lib/storage/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves a bundle's own cover image.
 *
 * Public for the same reason a subject's cover is (see `/api/subjects/[id]/cover`): it is
 * catalogue imagery, exactly as public as the bundle's title and price, and the browser never learns
 * a storage key — it asks for a bundle id and the bytes are streamed from private storage. Note
 * content is untouched and keeps its full authorisation chain.
 *
 * Draft bundles are served too, because the admin editor previews them through this same route and
 * the image optimiser fetches without a session. The id is an unguessable cuid and nothing links to
 * a draft, so a draft's image is not discoverable.
 *
 * The URL carries a version stamp, so replacing the image changes the URL and a long cache is safe.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const bundle = await prisma.bundle.findUnique({
      where: { id },
      select: { coverStorageKey: true, coverMimeType: true },
    });
    if (!bundle?.coverStorageKey) throw Errors.notFound('No cover for this bundle.');

    const driver = storage();
    const meta = await driver.head(bundle.coverStorageKey);
    if (!meta) {
      console.error('[cover] storage object missing for bundle', id, bundle.coverStorageKey);
      throw Errors.notFound('No cover for this bundle.');
    }

    return new NextResponse(await driver.getStream(bundle.coverStorageKey), {
      status: 200,
      headers: {
        'Content-Type': bundle.coverMimeType || meta.contentType || 'image/jpeg',
        'Content-Length': String(meta.size),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
