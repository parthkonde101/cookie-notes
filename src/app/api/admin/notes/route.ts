import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiAdmin } from '@/lib/auth/guards';
import { ingestPdfUpload } from '@/lib/notes/ingest';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import { firstError, noteUploadSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Puts a PDF into a unit.
 *
 * One unit holds one PDF, so this is an upsert rather than a create: if the unit
 * is empty a note is created, and if it already has one the file is replaced and
 * the previous file kept as a NoteVersion, exactly as the replace route does. A
 * second upload to the same unit can therefore never produce a second note — and
 * the database backs that up with a unique index on `notes."unitId"`, so even a
 * racing pair of requests ends with one note.
 *
 * The note's title is the unit's name. There is no separate title to type in and
 * none to keep in sync: a unit's name is fixed once created.
 *
 * The file itself is validated by `ingestPdfUpload`, which handles both the
 * direct-to-storage and proxied upload shapes and never trusts a client claim
 * about an uploaded object.
 */
export async function POST(request: NextRequest) {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = contextFromHeaders(request.headers);

    const form = await request.formData();

    const parsed = noteUploadSchema.safeParse({
      subjectId: String(form.get('subjectId') ?? ''),
      unitId: String(form.get('unitId') ?? ''),
      status: String(form.get('status') ?? 'PUBLISHED'),
      visibility: String(form.get('visibility') ?? 'RESTRICTED'),
      price: String(form.get('price') ?? '0'),
    });
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));
    const meta = parsed.data;

    // The unit must exist and belong to the chosen subject — a client is never
    // trusted to have sent a matching pair.
    const unit = await prisma.unit.findFirst({
      where: { id: meta.unitId, subjectId: meta.subjectId },
      select: {
        id: true,
        name: true,
        notes: {
          select: { id: true, version: true, status: true, publishedAt: true, archivedAt: true },
          take: 1,
        },
      },
    });
    if (!unit) throw Errors.validation('That unit does not belong to the selected subject.');

    const existing = unit.notes[0] ?? null;
    const priceMinor = Math.round((meta.price ?? 0) * 100);

    const uploaded = await ingestPdfUpload(form, { fallbackFileName: `${unit.name}.pdf` });
    const { storageKey, fileName, fileSize, checksum, pageCount } = uploaded;

    if (existing) {
      // --- replacement ---
      const nextVersion = existing.version + 1;
      const note = await prisma.$transaction(async (tx) => {
        await tx.noteVersion.create({
          data: {
            noteId: existing.id,
            version: nextVersion,
            storageKey,
            fileName,
            fileSize,
            checksum,
            createdById: admin.id,
          },
        });
        return tx.note.update({
          where: { id: existing.id },
          data: {
            title: unit.name,
            storageKey,
            fileName,
            fileSize,
            checksum,
            pageCount,
            version: nextVersion,
            status: meta.status,
            visibility: meta.visibility,
            priceMinor,
            // Timestamps mark transitions, so replacing the file of an
            // already-published note leaves its publication date alone.
            publishedAt:
              meta.status === 'PUBLISHED'
                ? (existing.publishedAt ?? new Date())
                : existing.publishedAt,
            archivedAt:
              meta.status === 'ARCHIVED' ? (existing.archivedAt ?? new Date()) : null,
          },
          select: { id: true, title: true },
        });
      });

      await writeAudit({
        action: 'NOTE_REPLACED',
        actorId: admin.id,
        actorEmail: admin.email,
        targetType: 'note',
        targetId: note.id,
        targetLabel: note.title,
        metadata: { from: existing.version, to: nextVersion, fileName, fileSize },
        ctx,
      });
      await recordEvent({
        type: 'NOTE_REPLACED',
        userId: admin.id,
        noteId: note.id,
        subjectId: meta.subjectId,
        ctx,
        metadata: { version: nextVersion, fileSize },
      });

      return NextResponse.json({ ok: true, noteId: note.id, replaced: true });
    }

    // --- first upload for this unit ---
    const note = await prisma.note.create({
      data: {
        title: unit.name,
        subjectId: meta.subjectId,
        unitId: unit.id,
        status: meta.status,
        visibility: meta.visibility,
        priceMinor,
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
        priceMinor,
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

    return NextResponse.json({ ok: true, noteId: note.id, replaced: false }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
