import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiAdmin } from '@/lib/auth/guards';
import { storage } from '@/lib/storage/index';
import { bundleCoverOwner, receiveCover } from '@/lib/storage/cover-upload';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Attaches (or replaces) a bundle's own cover image.
 *
 * This only stores the image. Whether the bundle *uses* it is the cover mode the admin saves with
 * the rest of the form, so uploading never changes what students see by itself, and an image can
 * be uploaded, previewed and then discarded by choosing another mode. The previous image is
 * deleted once the row points at the new one, so a replaced cover never lingers in the bucket.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user: admin } = await requireApiAdmin();
    const ctx = contextFromHeaders(request.headers);

    const bundle = await prisma.bundle.findUnique({
      where: { id },
      select: { id: true, title: true, coverStorageKey: true },
    });
    if (!bundle) throw Errors.notFound('That bundle does not exist.');

    const { key, mimeType } = await receiveCover(await request.formData(), bundleCoverOwner(bundle.id));

    const updatedAt = new Date();
    await prisma.bundle.update({
      where: { id: bundle.id },
      data: { coverStorageKey: key, coverMimeType: mimeType, coverUpdatedAt: updatedAt },
    });

    const previous = bundle.coverStorageKey;
    if (previous && previous !== key) {
      await storage().delete(previous).catch(() => undefined);
    }

    await writeAudit({
      action: 'BUNDLE_UPDATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'bundle',
      targetId: bundle.id,
      targetLabel: bundle.title,
      metadata: { cover: 'uploaded', mimeType, replaced: Boolean(previous) },
      ctx,
    });

    return NextResponse.json({ ok: true, updatedAt: updatedAt.getTime() }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Deletes the uploaded image. A bundle that was using it falls back to its subject's cover. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user: admin } = await requireApiAdmin();
    const ctx = contextFromHeaders(request.headers);

    const bundle = await prisma.bundle.findUnique({
      where: { id },
      select: { id: true, title: true, coverStorageKey: true, coverMode: true },
    });
    if (!bundle) throw Errors.notFound('That bundle does not exist.');
    if (!bundle.coverStorageKey) return NextResponse.json({ ok: true });

    await prisma.bundle.update({
      where: { id: bundle.id },
      data: {
        coverStorageKey: null,
        coverMimeType: null,
        coverUpdatedAt: null,
        // A bundle cannot "use" an image that is gone.
        ...(bundle.coverMode === 'CUSTOM' ? { coverMode: 'SUBJECT' as const } : {}),
      },
    });
    await storage().delete(bundle.coverStorageKey).catch(() => undefined);

    await writeAudit({
      action: 'BUNDLE_UPDATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'bundle',
      targetId: bundle.id,
      targetLabel: bundle.title,
      metadata: { cover: 'removed' },
      ctx,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
