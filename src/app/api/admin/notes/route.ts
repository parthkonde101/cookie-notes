import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiAdmin } from '@/lib/auth/guards';
import { ingestPdfUpload } from '@/lib/notes/ingest';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import { notifyNoteReady, type NotifyNoteReadyResult } from '@/lib/notes/notifications';
import { firstError, noteUploadSchema } from '@/lib/validation';
import { parseProgram, programLabel } from '@/lib/program';

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

    // Opt-in, off unless the admin ticked the box in the upload dialog.
    const notifyAll = String(form.get('notifyAll') ?? '') === 'true';

    // The unit must exist and belong to the chosen subject — a client is never
    // trusted to have sent a matching pair. The subject's program comes back in
    // the same query, for the cross-program check below.
    const unit = await prisma.unit.findFirst({
      where: { id: meta.unitId, subjectId: meta.subjectId },
      select: {
        id: true,
        name: true,
        subject: { select: { semester: { select: { program: true } } } },
        notes: {
          select: { id: true, version: true, status: true, publishedAt: true, archivedAt: true },
          take: 1,
        },
      },
    });
    if (!unit) throw Errors.validation('That unit does not belong to the selected subject.');

    /*
     * CROSS-PROGRAM GUARD.
     *
     * The form says which catalogue the admin believes they are filing into;
     * `unit.subject.semester.program` is where the PDF would actually land. A
     * stale tab left open across a program switch, a double-submit, or a
     * hand-made request can make those disagree, and nothing downstream would
     * catch it — a note has no program of its own, so a misfiled PDF simply
     * appears on the wrong shelf and looks correct.
     *
     * The claimed program is only ever compared, never written. When the form
     * does not send one (an older client), there is nothing to contradict and
     * the placement stands on its own: the unit still had to belong to the
     * subject, which is the check that was always here.
     */
    const claimedProgram = parseProgram(form.get('program'));
    const actualProgram = unit.subject.semester.program;
    if (claimedProgram && claimedProgram !== actualProgram) {
      throw Errors.validation(
        `That unit is in the ${programLabel(actualProgram)} catalogue, but this upload is filing into ${programLabel(claimedProgram)}. Switch programme and try again.`,
      );
    }

    const existing = unit.notes[0] ?? null;
    const priceMinor = Math.round((meta.price ?? 0) * 100);

    const uploaded = await ingestPdfUpload(form, { fallbackFileName: `${unit.name}.pdf` });
    const { storageKey, fileName, fileSize, checksum, pageCount } = uploaded;

    if (existing) {
      // --- replacement ---
      const nextVersion = existing.version + 1;
      const { note, version } = await prisma.$transaction(async (tx) => {
        const created = await tx.noteVersion.create({
          data: {
            noteId: existing.id,
            version: nextVersion,
            storageKey,
            fileName,
            fileSize,
            checksum,
            createdById: admin.id,
          },
          select: { id: true },
        });
        const updated = await tx.note.update({
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
        return { note: updated, version: created };
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

      // Replacing an existing PDF is not a "notes are ready" moment — the notes
      // were already there — so subscribers are deliberately NOT notified on
      // their own. Only an explicit "Notify all users" tick sends anything.
      const notified = notifyAll
        ? await notifySafely({
            unitId: unit.id,
            noteId: note.id,
            noteVersionId: version.id,
            notifyAll: true,
            notifySubscribers: false,
            actor: admin,
            ctx,
          })
        : null;

      return NextResponse.json({
        ok: true,
        noteId: note.id,
        replaced: true,
        notified: notified?.sent ?? 0,
        notifyFailures: notified?.failed ?? 0,
      });
    }

    // --- first upload for this unit ---
    //
    // The note and the clearing of "Being Baked" commit together. A unit is
    // therefore never observable — by a refresh, another browser, a direct API
    // call or the admin screen — as holding a PDF while still flagged as baking.
    const { note, versionId } = await prisma.$transaction(async (tx) => {
      const created = await tx.note.create({
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
        select: { id: true, title: true, versions: { select: { id: true }, take: 1 } },
      });

      await tx.unit.update({ where: { id: unit.id }, data: { beingBaked: false } });

      return { note: created, versionId: created.versions[0]?.id ?? created.id };
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

    // NO PDF → PDF AVAILABLE. This is the only transition that notifies
    // subscribers on its own; "Notify all" widens the audience but is not what
    // makes it a notifiable moment.
    //
    // Reached only after the transaction above committed, so a storage failure
    // or a failed write has already thrown and nobody has been mailed.
    const notified = await notifySafely({
      unitId: unit.id,
      noteId: note.id,
      noteVersionId: versionId,
      notifyAll,
      notifySubscribers: true,
      actor: admin,
      ctx,
    });

    return NextResponse.json(
      {
        ok: true,
        noteId: note.id,
        replaced: false,
        notified: notified?.sent ?? 0,
        notifyFailures: notified?.failed ?? 0,
      },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Dispatches note-ready mail without ever putting the upload at risk.
 *
 * The note is already published by the time this runs. If the mail provider is
 * down, misconfigured or throws, that is logged and the request still succeeds:
 * an admin who uploaded a PDF has uploaded a PDF, whatever the email service
 * thinks. Per-recipient failures are recorded on their notification rows.
 */
async function notifySafely(
  input: Parameters<typeof notifyNoteReady>[0],
): Promise<NotifyNoteReadyResult | null> {
  try {
    return await notifyNoteReady(input);
  } catch (error) {
    console.error(
      '[notify] note-ready dispatch failed for unit',
      input.unitId,
      '— the note is published and unaffected:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
