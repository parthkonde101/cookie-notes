import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiAdmin } from '@/lib/auth/guards';
import {
  buildCoverKey,
  isCoverMimeType,
  MAX_COVER_BYTES,
  readImageSize,
  sniffImageMimeType,
  storage,
} from '@/lib/storage/index';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** A cover smaller than this is a placeholder or a tracking pixel, not artwork. */
const MIN_DIMENSION = 200;
/** Guards against a decompression bomb dressed up as a notebook cover. */
const MAX_DIMENSION = 6000;

/**
 * Attaches (or replaces) a subject's notebook cover.
 *
 * Mirrors the note upload contract exactly: the browser has already PUT the
 * image to private storage with a short-lived presigned URL and sends us only
 * the key. Nothing the client claims is trusted — the bytes are read back out of
 * storage and checked before a single column is written.
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

    const form = await request.formData();
    const uploadedKey = String(form.get('storageKey') ?? '');
    const file = form.get('file');

    const driver = storage();
    let key: string;
    let mimeType: string;

    if (uploadedKey) {
      // --- direct-to-storage upload ---
      // The key must be one we minted for this subject, so a compromised client
      // cannot point the cover at an unrelated object such as a note PDF.
      if (!uploadedKey.startsWith(`covers/${subject.id}/`)) {
        throw Errors.validation('Invalid upload reference.');
      }

      const head = await driver.head(uploadedKey);
      if (!head) throw Errors.validation('The upload did not complete. Please try again.');
      if (head.size > MAX_COVER_BYTES) {
        await driver.delete(uploadedKey);
        throw Errors.validation('Cover images must be 5 MB or smaller.');
      }

      // Read enough of the header to identify the format and its dimensions.
      const header = await driver.getRange(uploadedKey, 0, Math.min(head.size, 65_535) - 1);
      const sniffed = sniffImageMimeType(header);
      if (!sniffed) {
        await driver.delete(uploadedKey);
        throw Errors.validation('That file is not a JPG, PNG or WebP image.');
      }

      const size = readImageSize(header);
      if (size && (size.width < MIN_DIMENSION || size.height < MIN_DIMENSION)) {
        await driver.delete(uploadedKey);
        throw Errors.validation(
          `That image is ${size.width}×${size.height}. Covers should be at least ${MIN_DIMENSION}px on each side.`,
        );
      }
      if (size && (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION)) {
        await driver.delete(uploadedKey);
        throw Errors.validation(`Covers must be ${MAX_DIMENSION}px or smaller on each side.`);
      }

      key = uploadedKey;
      mimeType = sniffed;
    } else {
      // --- proxied upload (local storage driver, and small files anywhere) ---
      if (!(file instanceof File)) throw Errors.validation('Choose an image to upload.');
      if (file.size === 0) throw Errors.validation('That file is empty.');
      if (file.size > MAX_COVER_BYTES) {
        throw Errors.validation('Cover images must be 5 MB or smaller.');
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const sniffed = sniffImageMimeType(buffer);
      if (!sniffed) throw Errors.validation('That file is not a JPG, PNG or WebP image.');
      if (file.type && isCoverMimeType(file.type) && file.type !== sniffed) {
        throw Errors.validation('That file does not match the image type it claims to be.');
      }

      const size = readImageSize(buffer);
      if (size && (size.width < MIN_DIMENSION || size.height < MIN_DIMENSION)) {
        throw Errors.validation(
          `That image is ${size.width}×${size.height}. Covers should be at least ${MIN_DIMENSION}px on each side.`,
        );
      }
      if (size && (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION)) {
        throw Errors.validation(`Covers must be ${MAX_DIMENSION}px or smaller on each side.`);
      }

      key = buildCoverKey(subject.id, sniffed);
      await driver.put(key, buffer, sniffed);
      mimeType = sniffed;
    }

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
