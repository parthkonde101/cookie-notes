import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiAdmin } from '@/lib/auth/guards';
import { buildNoteKey, looksLikePdf, storage } from '@/lib/storage/index';
import { inspectPdf } from '@/lib/notes/pdf-meta';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import { firstError, noteMetadataSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Creates a note.
 *
 * Two upload shapes are supported:
 *   • proxy   — the browser posts the file here and the server writes it to
 *               private storage (local driver, and small files anywhere).
 *   • direct  — the browser already PUT the file to object storage with a
 *               short-lived presigned URL and sends us the key. The server then
 *               reads the object's header and size back out of storage to
 *               validate it, so a client claim is never taken on trust.
 */
export async function POST(request: NextRequest) {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = contextFromHeaders(request.headers);

    const form = await request.formData();

    const parsed = noteMetadataSchema.safeParse({
      title: String(form.get('title') ?? '').trim(),
      description: String(form.get('description') ?? '').trim(),
      subjectId: String(form.get('subjectId') ?? ''),
      unitId: String(form.get('unitId') ?? ''),
      topicId: String(form.get('topicId') ?? ''),
      status: String(form.get('status') ?? 'PUBLISHED'),
      visibility: String(form.get('visibility') ?? 'RESTRICTED'),
      price: String(form.get('price') ?? '0'),
    });
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));
    const meta = parsed.data;

    await assertPlacement(meta.subjectId, meta.unitId || null, meta.topicId || null);

    const driver = storage();
    const uploadedKey = String(form.get('storageKey') ?? '');
    const file = form.get('file');

    let storageKey: string;
    let fileName: string;
    let fileSize: number;
    let checksum: string | null = null;
    let pageCount: number | null = null;

    if (uploadedKey) {
      // --- direct-to-storage upload ---
      if (!uploadedKey.startsWith('notes/')) throw Errors.validation('Invalid upload reference.');

      const head = await driver.head(uploadedKey);
      if (!head) throw Errors.validation('The upload did not complete. Please try again.');
      if (head.size > env.uploads.maxBytes) {
        await driver.delete(uploadedKey);
        throw Errors.validation(`Files must be ${env.uploads.maxMb} MB or smaller.`);
      }

      const header = await driver.getRange(uploadedKey, 0, 1023);
      if (!looksLikePdf(header)) {
        await driver.delete(uploadedKey);
        throw Errors.validation('That file is not a valid PDF.');
      }

      storageKey = uploadedKey;
      fileSize = head.size;
      fileName = String(form.get('fileName') ?? 'note.pdf').slice(0, 200);
    } else {
      // --- proxied upload ---
      if (!(file instanceof File)) throw Errors.validation('Choose a PDF file to upload.');
      if (file.size === 0) throw Errors.validation('That file is empty.');
      if (file.size > env.uploads.maxBytes) {
        throw Errors.validation(`Files must be ${env.uploads.maxMb} MB or smaller.`);
      }
      if (file.type && !env.uploads.allowedMimeTypes.includes(file.type as 'application/pdf')) {
        throw Errors.validation('Only PDF files are supported right now.');
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const inspection = inspectPdf(buffer);
      if (!inspection.valid) throw Errors.validation(inspection.reason ?? 'Invalid PDF.');

      storageKey = buildNoteKey(file.name);
      await driver.put(storageKey, buffer, 'application/pdf');

      fileName = file.name.slice(0, 200);
      fileSize = buffer.byteLength;
      checksum = inspection.checksum;
      pageCount = inspection.pageCount;
    }

    const note = await prisma.note.create({
      data: {
        title: meta.title,
        description: meta.description || null,
        subjectId: meta.subjectId,
        unitId: meta.unitId || null,
        topicId: meta.topicId || null,
        status: meta.status,
        visibility: meta.visibility,
        priceMinor: Math.round((meta.price ?? 0) * 100),
        storageKey,
        fileName,
        fileSize,
        checksum,
        pageCount,
        mimeType: 'application/pdf',
        uploadedById: admin.id,
        publishedAt: meta.status === 'PUBLISHED' ? new Date() : null,
        versions: {
          create: { version: 1, storageKey, fileName, fileSize, checksum, createdById: admin.id },
        },
      },
      select: { id: true, title: true },
    });

    await writeAudit({
      action: 'NOTE_UPLOADED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'note',
      targetId: note.id,
      targetLabel: note.title,
      metadata: {
        fileName,
        fileSize,
        status: meta.status,
        visibility: meta.visibility,
        priceMinor: Math.round((meta.price ?? 0) * 100),
      },
      ctx,
    });
    await recordEvent({
      type: 'NOTE_UPLOADED',
      userId: admin.id,
      noteId: note.id,
      subjectId: meta.subjectId,
      ctx,
      metadata: { fileSize },
    });

    return NextResponse.json({ ok: true, noteId: note.id }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** A note's unit must belong to its subject, and its topic to that unit. */
async function assertPlacement(subjectId: string, unitId: string | null, topicId: string | null) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId }, select: { id: true } });
  if (!subject) throw Errors.validation('Choose a valid subject.');

  if (unitId) {
    const unit = await prisma.unit.findFirst({
      where: { id: unitId, subjectId },
      select: { id: true },
    });
    if (!unit) throw Errors.validation('That unit does not belong to the selected subject.');
  }

  if (topicId) {
    if (!unitId) throw Errors.validation('Pick a unit before choosing a topic.');
    const topic = await prisma.topic.findFirst({
      where: { id: topicId, unitId },
      select: { id: true },
    });
    if (!topic) throw Errors.validation('That topic does not belong to the selected unit.');
  }
}
