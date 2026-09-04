import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiAdmin } from '@/lib/auth/guards';
import { ingestPdfUpload } from '@/lib/notes/ingest';
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

    // Same acceptance checks as a first upload — see `ingestPdfUpload`.
    const { storageKey, fileName, fileSize, checksum, pageCount } = await ingestPdfUpload(form, {
      fallbackFileName: note.fileName,
    });

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
