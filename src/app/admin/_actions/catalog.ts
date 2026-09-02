'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { Errors, toActionError } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/auth/guards';
import { requestContext } from '@/lib/request';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import { firstError, semesterSchema, subjectSchema, topicSchema, unitSchema } from '@/lib/validation';
import { slugify } from '@/lib/utils';
import type { ActionResult } from '@/app/admin/_actions/users';

function value(form: FormData, key: string): string {
  const raw = form.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Slugs are user-visible URLs, so make them unique without surprising the admin. */
async function uniqueSlug(base: string, table: 'semester' | 'subject'): Promise<string> {
  const root = slugify(base) || 'item';
  let candidate = root;
  let suffix = 2;

  for (;;) {
    const existing =
      table === 'semester'
        ? await prisma.semester.findUnique({ where: { slug: candidate }, select: { id: true } })
        : await prisma.subject.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing) return candidate;
    candidate = `${root}-${suffix++}`;
  }
}

// --- Semesters -------------------------------------------------------------

export async function createSemesterAction(form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const parsed = semesterSchema.safeParse({
      name: value(form, 'name'),
      description: value(form, 'description'),
      position: value(form, 'position') || 0,
    });
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const semester = await prisma.semester.create({
      data: {
        name: parsed.data.name,
        slug: await uniqueSlug(parsed.data.name, 'semester'),
        description: parsed.data.description || null,
        position: parsed.data.position ?? 0,
      },
    });

    await writeAudit({
      action: 'SEMESTER_CREATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'semester',
      targetId: semester.id,
      targetLabel: semester.name,
      ctx,
    });
    await recordEvent({ type: 'CATALOG_MODIFIED', userId: admin.id, ctx, metadata: { created: 'semester' } });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: `${semester.name} added.` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function updateSemesterAction(id: string, form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const semester = await prisma.semester.update({
      where: { id },
      data: {
        name: value(form, 'name') || undefined,
        description: value(form, 'description') || null,
        position: value(form, 'position') ? Number(value(form, 'position')) : undefined,
        isArchived: form.get('isArchived') === 'on',
      },
    });

    await writeAudit({
      action: 'SEMESTER_UPDATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'semester',
      targetId: id,
      targetLabel: semester.name,
      ctx,
    });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteSemesterAction(id: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const semester = await prisma.semester.findUnique({
      where: { id },
      select: { name: true, _count: { select: { subjects: true } } },
    });
    if (!semester) throw Errors.notFound('That semester no longer exists.');
    if (semester._count.subjects > 0) {
      throw Errors.validation(
        'Move or delete this semester’s subjects first — deleting it would remove their notes.',
      );
    }

    await prisma.semester.delete({ where: { id } });
    await writeAudit({
      action: 'SEMESTER_DELETED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'semester',
      targetId: id,
      targetLabel: semester.name,
      ctx,
    });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: 'Semester deleted.' };
  } catch (error) {
    return toActionError(error);
  }
}

// --- Subjects --------------------------------------------------------------

export async function createSubjectAction(form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const parsed = subjectSchema.safeParse({
      semesterId: value(form, 'semesterId'),
      name: value(form, 'name'),
      code: value(form, 'code'),
      description: value(form, 'description'),
      position: value(form, 'position') || 0,
    });
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const duplicate = await prisma.subject.findFirst({
      where: { semesterId: parsed.data.semesterId, name: parsed.data.name },
      select: { id: true },
    });
    if (duplicate) throw Errors.conflict('That subject already exists in this semester.');

    const subject = await prisma.subject.create({
      data: {
        semesterId: parsed.data.semesterId,
        name: parsed.data.name,
        slug: await uniqueSlug(parsed.data.name, 'subject'),
        code: parsed.data.code || null,
        description: parsed.data.description || null,
        position: parsed.data.position ?? 0,
      },
    });

    await writeAudit({
      action: 'SUBJECT_CREATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'subject',
      targetId: subject.id,
      targetLabel: subject.name,
      ctx,
    });
    await recordEvent({ type: 'CATALOG_MODIFIED', userId: admin.id, ctx, metadata: { created: 'subject' } });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: `${subject.name} added.` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function updateSubjectAction(id: string, form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const subject = await prisma.subject.update({
      where: { id },
      data: {
        name: value(form, 'name') || undefined,
        code: value(form, 'code') || null,
        description: value(form, 'description') || null,
        position: value(form, 'position') ? Number(value(form, 'position')) : undefined,
        isArchived: form.get('isArchived') === 'on',
        semesterId: value(form, 'semesterId') || undefined,
      },
    });

    await writeAudit({
      action: 'SUBJECT_UPDATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'subject',
      targetId: id,
      targetLabel: subject.name,
      ctx,
    });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteSubjectAction(id: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const subject = await prisma.subject.findUnique({
      where: { id },
      select: { name: true, _count: { select: { notes: true } } },
    });
    if (!subject) throw Errors.notFound('That subject no longer exists.');
    if (subject._count.notes > 0) {
      throw Errors.validation(
        `This subject still has ${subject._count.notes} note(s). Archive it instead, or delete the notes first.`,
      );
    }

    await prisma.subject.delete({ where: { id } });
    await writeAudit({
      action: 'SUBJECT_DELETED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'subject',
      targetId: id,
      targetLabel: subject.name,
      ctx,
    });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: 'Subject deleted.' };
  } catch (error) {
    return toActionError(error);
  }
}

// --- Units & topics --------------------------------------------------------

export async function createUnitAction(form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const parsed = unitSchema.safeParse({
      subjectId: value(form, 'subjectId'),
      name: value(form, 'name'),
      description: value(form, 'description'),
      position: value(form, 'position') || 0,
    });
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const duplicate = await prisma.unit.findFirst({
      where: { subjectId: parsed.data.subjectId, name: parsed.data.name },
      select: { id: true },
    });
    if (duplicate) throw Errors.conflict('That unit already exists in this subject.');

    const unit = await prisma.unit.create({
      data: {
        subjectId: parsed.data.subjectId,
        name: parsed.data.name,
        description: parsed.data.description || null,
        position: parsed.data.position ?? 0,
      },
    });

    await writeAudit({
      action: 'UNIT_CREATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'unit',
      targetId: unit.id,
      targetLabel: unit.name,
      ctx,
    });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: `${unit.name} added.` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteUnitAction(id: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const unit = await prisma.unit.findUnique({
      where: { id },
      select: { name: true, _count: { select: { notes: true } } },
    });
    if (!unit) throw Errors.notFound('That unit no longer exists.');
    if (unit._count.notes > 0) {
      throw Errors.validation(
        `This unit still has ${unit._count.notes} note(s). Move or delete them first.`,
      );
    }

    await prisma.unit.delete({ where: { id } });
    await writeAudit({
      action: 'UNIT_DELETED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'unit',
      targetId: id,
      targetLabel: unit.name,
      ctx,
    });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: 'Unit deleted.' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function createTopicAction(form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const parsed = topicSchema.safeParse({
      unitId: value(form, 'unitId'),
      name: value(form, 'name'),
      position: value(form, 'position') || 0,
    });
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const duplicate = await prisma.topic.findFirst({
      where: { unitId: parsed.data.unitId, name: parsed.data.name },
      select: { id: true },
    });
    if (duplicate) throw Errors.conflict('That topic already exists in this unit.');

    const topic = await prisma.topic.create({
      data: {
        unitId: parsed.data.unitId,
        name: parsed.data.name,
        position: parsed.data.position ?? 0,
      },
    });

    await writeAudit({
      action: 'TOPIC_CREATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'topic',
      targetId: topic.id,
      targetLabel: topic.name,
      ctx,
    });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: `${topic.name} added.` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteTopicAction(id: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const topic = await prisma.topic.findUnique({ where: { id }, select: { name: true } });
    if (!topic) throw Errors.notFound('That topic no longer exists.');

    await prisma.topic.delete({ where: { id } });
    await writeAudit({
      action: 'TOPIC_DELETED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'topic',
      targetId: id,
      targetLabel: topic.name,
      ctx,
    });

    revalidatePath('/admin/notes');
    revalidatePath('/');
    return { ok: true, message: 'Topic deleted.' };
  } catch (error) {
    return toActionError(error);
  }
}
