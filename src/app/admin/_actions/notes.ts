'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { Errors, toActionError } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/auth/guards';
import { requestContext } from '@/lib/request';
import { storage } from '@/lib/storage/index';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import { firstError, noteMetadataSchema } from '@/lib/validation';
import type { ActionResult } from '@/app/admin/_actions/users';

function value(form: FormData, key: string): string {
  const raw = form.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}

export async function updateNoteAction(noteId: string, form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const existing = await prisma.note.findUnique({ where: { id: noteId } });
    if (!existing) throw Errors.notFound('That note no longer exists.');

    // The form no longer offers a topic. A note filed under the older model may
    // still have one, so it is carried over untouched rather than quietly
    // cleared — unless the note is being moved to a different unit, where the
    // old unit's topic genuinely no longer applies.
    const submittedUnitId = value(form, 'unitId');
    const topicId = form.has('topicId')
      ? value(form, 'topicId')
      : submittedUnitId === (existing.unitId ?? '')
        ? (existing.topicId ?? '')
        : '';

    const parsed = noteMetadataSchema.safeParse({
      title: value(form, 'title'),
      description: value(form, 'description'),
      subjectId: value(form, 'subjectId'),
      unitId: submittedUnitId,
      topicId,
      status: value(form, 'status') || 'PUBLISHED',
      visibility: value(form, 'visibility') || 'RESTRICTED',
      price: value(form, 'price') || '0',
    });
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));
    const meta = parsed.data;

    if (meta.unitId) {
      const unit = await prisma.unit.findFirst({
        where: { id: meta.unitId, subjectId: meta.subjectId },
        select: { id: true, name: true, notes: { select: { id: true }, take: 1 } },
      });
      if (!unit) throw Errors.validation('That unit does not belong to the selected subject.');

      // One unit, one PDF. Caught here so the admin gets a sentence rather than
      // a unique-constraint error from the database.
      const occupant = unit.notes[0];
      if (occupant && occupant.id !== noteId) {
        throw Errors.validation(
          `“${unit.name}” already has a PDF. Replace that one, or move it out first.`,
        );
      }
    }
    if (meta.topicId) {
      if (!meta.unitId) throw Errors.validation('Pick a unit before choosing a topic.');
      const topic = await prisma.topic.findFirst({
        where: { id: meta.topicId, unitId: meta.unitId },
        select: { id: true },
      });
      if (!topic) throw Errors.validation('That topic does not belong to the selected unit.');
    }

    const becamePublished = existing.status !== 'PUBLISHED' && meta.status === 'PUBLISHED';
    const becameArchived = existing.status !== 'ARCHIVED' && meta.status === 'ARCHIVED';

    await prisma.note.update({
      where: { id: noteId },
      data: {
        title: meta.title,
        description: meta.description || null,
        subjectId: meta.subjectId,
        unitId: meta.unitId || null,
        topicId: meta.topicId || null,
        status: meta.status,
        visibility: meta.visibility,
        priceMinor: Math.round((meta.price ?? 0) * 100),
        publishedAt: becamePublished ? new Date() : existing.publishedAt,
        archivedAt: becameArchived ? new Date() : meta.status === 'ARCHIVED' ? existing.archivedAt : null,
      },
    });

    await writeAudit({
      action: becamePublished ? 'NOTE_PUBLISHED' : becameArchived ? 'NOTE_ARCHIVED' : 'NOTE_UPDATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'note',
      targetId: noteId,
      targetLabel: meta.title,
      metadata: { status: meta.status, visibility: meta.visibility },
      ctx,
    });
    await recordEvent({ type: 'NOTE_UPDATED', userId: admin.id, noteId, ctx });

    revalidatePath('/admin/notes');
    revalidatePath(`/admin/notes/${noteId}`);
    revalidatePath('/');
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteNoteAction(noteId: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const note = await prisma.note.findUnique({
      where: { id: noteId },
      include: { versions: { select: { storageKey: true } } },
    });
    if (!note) throw Errors.notFound('That note no longer exists.');

    await writeAudit({
      action: 'NOTE_DELETED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'note',
      targetId: noteId,
      targetLabel: note.title,
      metadata: { fileName: note.fileName, viewCount: note.viewCount },
      ctx,
    });

    await prisma.note.delete({ where: { id: noteId } });

    // Remove the stored files after the row is gone; a leftover object is
    // harmless, a dangling row is not.
    const keys = new Set([note.storageKey, ...note.versions.map((v) => v.storageKey)]);
    const driver = storage();
    await Promise.all(
      [...keys].map((key) =>
        driver.delete(key).catch((error) => console.error('[notes] storage delete failed', key, error)),
      ),
    );

    await recordEvent({ type: 'NOTE_DELETED', userId: admin.id, ctx, metadata: { noteId, title: note.title } });

    revalidatePath('/admin/notes');
    return { ok: true, message: `“${note.title}” deleted.` };
  } catch (error) {
    return toActionError(error);
  }
}
