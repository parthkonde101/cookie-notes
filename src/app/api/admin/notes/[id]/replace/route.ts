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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Replaces a note's file, bumping its version. The previous file is kept as a
 * NoteVersion row so an upload mistake is recoverable.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user: admin } = await requireApiAdmin();
    const ctx = contextFromHeaders(request.headers);

    const note = await prisma.note.findUnique({ where: { id } });
    if (!note) throw Errors.notFound('That note no longer exists.');

    const form = await request.formData();
    const driver = storage();
    const uploadedKey = String(form.get('storageKey') ?? '');
    const file = form.get('file');

    let storageKey: string;
    let fileName: string;
    let fileSize: number;
    let checksum: string | null = null;
    let pageCount: number | null = null;

    if (uploadedKey) {
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
      fileName = String(form.get('fileName') ?? note.fileName).slice(0, 200);
    } else {
      if (!(file instanceof File)) throw Errors.validation('Choose a PDF file to upload.');
      if (file.size > env.uploads.maxBytes) {
        throw Errors.validation(`Files must be ${env.uploads.maxMb} MB or smaller.`);
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

    const nextVersion = note.version + 1;

    await prisma.$transaction([
      prisma.noteVersion.create({
        data: {
          noteId: note.id,
          version: nextVersion,
          storageKey,
          fileName,
          fileSize,
          checksum,
          createdById: admin.id,
        },
      }),
      prisma.note.update({
        where: { id: note.id },
        data: { storageKey, fileName, fileSize, checksum, pageCount, version: nextVersion },
      }),
    ]);

    await writeAudit({
      action: 'NOTE_REPLACED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'note',
      targetId: note.id,
      targetLabel: note.title,
      metadata: { from: note.version, to: nextVersion, fileName },
      ctx,
    });
    await recordEvent({
      type: 'NOTE_REPLACED',
      userId: admin.id,
      noteId: note.id,
      ctx,
      metadata: { version: nextVersion },
    });

    return NextResponse.json({ ok: true, version: nextVersion });
  } catch (error) {
    return toErrorResponse(error);
  }
}
