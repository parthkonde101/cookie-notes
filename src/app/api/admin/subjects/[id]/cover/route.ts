import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiAdmin } from '@/lib/auth/guards';
import { storage } from '@/lib/storage/index';
import { receiveCover } from '@/lib/storage/cover-upload';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Attaches (or replaces) a subject's notebook cover.
 *
 * Mirrors the note upload contract exactly: the browser has already PUT the
 * image to private storage with a short-lived presigned URL and sends us only
 * the key. Nothing the client claims is trusted — `receiveCover` reads the bytes
 * back out of storage and checks them before a single column is written.
 *
 * Replacing a cover deletes the previous object, so an unused image never lingers
 * in the bucket.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user: admin } = await requireApiAdmin();
    const ctx = contextFromHeaders(request.headers);

    const subject = await prisma.subject.findUnique({
      where: { id },
      select: { id: true, name: true, coverStorageKey: true },
    });
    if (!subject) throw Errors.notFound('That subject does not exist.');

    const { key, mimeType } = await receiveCover(await request.formData(), subject.id);
    const driver = storage();

    const previous = subject.coverStorageKey;

    await prisma.subject.update({
      where: { id: subject.id },
      data: { coverStorageKey: key, coverMimeType: mimeType, coverUpdatedAt: new Date() },
    });

    // Only after the row points at the new object — an orphaned image is
    // harmless, a subject pointing at a deleted one is not.
    if (previous && previous !== key) {
      await driver.delete(previous).catch(() => undefined);
    }

    await writeAudit({
      action: 'SUBJECT_COVER_UPDATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'subject',
      targetId: subject.id,
      targetLabel: subject.name,
      metadata: { mimeType, replaced: Boolean(previous) },
      ctx,
    });
    await recordEvent({
      type: 'SUBJECT_COVER_UPDATED',
      userId: admin.id,
      subjectId: subject.id,
      ctx,
      metadata: { mimeType },
    });

    return NextResponse.json({ ok: true, updatedAt: Date.now() }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Removes a subject's cover and falls back to the generated notebook design. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user: admin } = await requireApiAdmin();
    const ctx = contextFromHeaders(request.headers);

    const subject = await prisma.subject.findUnique({
      where: { id },
      select: { id: true, name: true, coverStorageKey: true },
    });
    if (!subject) throw Errors.notFound('That subject does not exist.');
    if (!subject.coverStorageKey) return NextResponse.json({ ok: true });

    await prisma.subject.update({
      where: { id: subject.id },
      data: { coverStorageKey: null, coverMimeType: null, coverUpdatedAt: null },
    });
    await storage().delete(subject.coverStorageKey).catch(() => undefined);

    await writeAudit({
      action: 'SUBJECT_COVER_UPDATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'subject',
      targetId: subject.id,
      targetLabel: subject.name,
      metadata: { removed: true },
      ctx,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
