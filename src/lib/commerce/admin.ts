import 'server-only';
import { prisma } from '@/lib/prisma';
import { Errors } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/request';
import { formatInr, parsePriceInput } from '@/lib/commerce/money';

/**
 * The rules for pricing a note and composing a bundle.
 *
 * Kept apart from the server actions that call them so the rules can be exercised directly:
 * the actions add what only a request has — who is asking (re-read from the database),
 * cache revalidation and redirects. Everything here validates its input as if it came from
 * an attacker, because by the time it gets here it came from a form, and a form is not a
 * guarantee of anything.
 */

export interface AdminActor {
  id: string;
  email: string;
}

export type NoteAccessMode = 'FREE' | 'RESTRICTED' | 'PAID';

// ---------------------------------------------------------------------------
// One note
// ---------------------------------------------------------------------------

/**
 * Sets how one note is offered.
 *
 *   FREE        any signed-in student may open it            (visibility FREE, not for sale)
 *   RESTRICTED  a grant is needed — or open preview, if on   (the existing behaviour)
 *   PAID        for sale at the given price                  (visibility RESTRICTED, isPaid)
 *
 * A price only exists for PAID. Switching to FREE or RESTRICTED clears it, so a stale price can
 * never make a note purchasable, and the database independently refuses a paid note that is free
 * or has no valid price. Students who already bought the note keep it whatever the mode becomes;
 * the price on every past order is untouched.
 */
export async function setNoteAccess(input: {
  noteId: string;
  mode: string;
  priceRaw: string;
  actor: AdminActor;
  ctx?: RequestContext | null;
}): Promise<{ message: string; changed: boolean }> {
  const note = await prisma.note.findUnique({
    where: { id: input.noteId },
    select: { id: true, title: true, status: true, isPaid: true, priceMinor: true, visibility: true },
  });
  if (!note) throw Errors.notFound('That note no longer exists.');

  const mode = input.mode;
  if (mode !== 'FREE' && mode !== 'RESTRICTED' && mode !== 'PAID') {
    throw Errors.validation('Choose how this note is offered.');
  }

  let priceMinor = 0;
  if (mode === 'PAID') {
    const parsed = parsePriceInput(input.priceRaw);
    if (!parsed.ok) throw Errors.validation(parsed.error);
    priceMinor = parsed.minor;
  }

  const before: NoteAccessMode = note.isPaid ? 'PAID' : note.visibility === 'FREE' ? 'FREE' : 'RESTRICTED';
  const changed = !(before === mode && note.priceMinor === priceMinor);

  await prisma.note.update({
    where: { id: note.id },
    data: {
      isPaid: mode === 'PAID',
      visibility: mode === 'FREE' ? 'FREE' : 'RESTRICTED',
      priceMinor,
    },
  });

  if (changed) {
    await writeAudit({
      action: 'NOTE_PRICE_CHANGED',
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      targetType: 'note',
      targetId: note.id,
      targetLabel: note.title,
      metadata: { from: { mode: before, priceMinor: note.priceMinor }, to: { mode, priceMinor } },
      ctx: input.ctx,
    });
  }

  const inBundles =
    mode !== 'PAID' ? await prisma.bundleItem.count({ where: { noteId: note.id, bundle: { isActive: true } } }) : 0;
  const notes: string[] = [];
  if (mode === 'PAID' && note.status !== 'PUBLISHED') notes.push('It cannot be bought until it is published.');
  if (inBundles > 0) notes.push(`It is still in ${inBundles} active ${inBundles === 1 ? 'bundle' : 'bundles'}.`);

  return {
    changed,
    message: (mode === 'PAID'
      ? `For sale at ${formatInr(priceMinor)}. ${notes.join(' ')}`
      : `Saved as ${mode === 'FREE' ? 'free' : 'restricted'}. ${notes.join(' ')}`
    ).trim(),
  };
}

/**
 * A note that has been sold is part of a customer's purchase and of the financial record:
 * deleting it would delete what they paid for. It can only be archived. Throws if it has sales
 * or live purchased access.
 */
export async function assertNoteDeletable(noteId: string): Promise<void> {
  const sold = await prisma.orderItem.count({
    where: { noteId, order: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } },
  });
  const owned = await prisma.purchaseGrant.count({ where: { noteId, revokedAt: null } });
  if (sold > 0 || owned > 0) {
    throw Errors.conflict(
      'This note has been purchased, so it cannot be deleted. Archive it instead — students who bought it keep their record, and it disappears from the catalogue.',
    );
  }
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

export const MAX_BUNDLE_NOTES = 60;

export async function createBundle(input: {
  title: string;
  priceRaw: string;
  actor: AdminActor;
  ctx?: RequestContext | null;
}): Promise<{ id: string }> {
  const title = input.title.trim();
  if (title.length < 2 || title.length > 120) throw Errors.validation('Give the bundle a title (2–120 characters).');
  const price = parsePriceInput(input.priceRaw);
  if (!price.ok) throw Errors.validation(price.error);

  const bundle = await prisma.bundle.create({
    data: { title, priceMinor: price.minor, isActive: false, createdById: input.actor.id },
    select: { id: true },
  });
  await writeAudit({
    action: 'BUNDLE_CREATED',
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    targetType: 'bundle',
    targetId: bundle.id,
    targetLabel: title,
    metadata: { priceMinor: price.minor },
    ctx: input.ctx,
  });
  return { id: bundle.id };
}

export interface BundleInput {
  bundleId: string;
  title: string;
  description: string;
  priceRaw: string;
  position: string;
  isActive: boolean;
  isFeatured: boolean;
  noteIds: string[];
  subjectIds: string[];
  coverSubjectId: string | null;
  actor: AdminActor;
  ctx?: RequestContext | null;
}

/**
 * Saves a bundle. To be ACTIVE it must be one a student could actually buy — at least two notes,
 * all for sale and published, promoted on at least one subject, priced in range. An inactive
 * bundle can be saved half-finished. Notes in a bundle must be for sale: a free note has no price
 * to bundle.
 */
export async function saveBundle(input: BundleInput): Promise<{ message: string }> {
  const existing = await prisma.bundle.findUnique({ where: { id: input.bundleId }, select: { id: true } });
  if (!existing) throw Errors.notFound('That bundle no longer exists.');

  const title = input.title.trim();
  if (title.length < 2 || title.length > 120) throw Errors.validation('Give the bundle a title (2–120 characters).');
  const description = input.description.trim();
  if (description.length > 1000) throw Errors.validation('The description is too long (1,000 characters at most).');

  const price = parsePriceInput(input.priceRaw);
  if (!price.ok) throw Errors.validation(price.error);

  const position = Number.parseInt(input.position || '0', 10);
  if (!Number.isInteger(position) || position < 0 || position > 9999) {
    throw Errors.validation('Display order must be a whole number from 0 to 9999.');
  }

  const noteIds = [...new Set(input.noteIds)];
  const subjectIds = [...new Set(input.subjectIds)];
  if (noteIds.length > MAX_BUNDLE_NOTES) throw Errors.validation(`A bundle can hold at most ${MAX_BUNDLE_NOTES} notes.`);

  const notes = await prisma.note.findMany({
    where: { id: { in: noteIds } },
    select: { id: true, title: true, isPaid: true, status: true },
  });
  if (notes.length !== noteIds.length) throw Errors.validation('One of the chosen notes no longer exists.');
  const notForSale = notes.filter((note) => !note.isPaid);
  if (notForSale.length > 0) {
    throw Errors.validation(
      `Only notes that are for sale can be bundled. Not for sale: ${notForSale.map((n) => n.title).slice(0, 3).join(', ')}.`,
    );
  }

  const subjects = await prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true } });
  if (subjects.length !== subjectIds.length) throw Errors.validation('One of the chosen subjects no longer exists.');
  if (input.coverSubjectId && !(await prisma.subject.count({ where: { id: input.coverSubjectId } }))) {
    throw Errors.validation('That cover subject no longer exists.');
  }

  if (input.isActive) {
    if (notes.length < 2) throw Errors.validation('Add at least two notes before making a bundle active.');
    const unpublished = notes.filter((note) => note.status !== 'PUBLISHED');
    if (unpublished.length > 0) {
      throw Errors.validation(`Publish these notes first: ${unpublished.map((n) => n.title).slice(0, 3).join(', ')}.`);
    }
    if (subjectIds.length === 0) {
      throw Errors.validation('Choose at least one subject page to promote it on before making it active.');
    }
  }

  const order = new Map(noteIds.map((id, index) => [id, index]));

  await prisma.$transaction(async (tx) => {
    await tx.bundle.update({
      where: { id: input.bundleId },
      data: {
        title,
        description: description || null,
        priceMinor: price.minor,
        isActive: input.isActive,
        isFeatured: input.isFeatured,
        position,
        coverSubjectId: input.coverSubjectId,
      },
    });
    await tx.bundleItem.deleteMany({ where: { bundleId: input.bundleId, noteId: { notIn: noteIds } } });
    for (const noteId of noteIds) {
      await tx.bundleItem.upsert({
        where: { bundleId_noteId: { bundleId: input.bundleId, noteId } },
        create: { bundleId: input.bundleId, noteId, position: order.get(noteId) ?? 0 },
        update: { position: order.get(noteId) ?? 0 },
      });
    }
    await tx.bundleSubject.deleteMany({ where: { bundleId: input.bundleId, subjectId: { notIn: subjectIds } } });
    for (const subjectId of subjectIds) {
      await tx.bundleSubject.upsert({
        where: { bundleId_subjectId: { bundleId: input.bundleId, subjectId } },
        create: { bundleId: input.bundleId, subjectId },
        update: {},
      });
    }
  });

  await writeAudit({
    action: 'BUNDLE_UPDATED',
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    targetType: 'bundle',
    targetId: input.bundleId,
    targetLabel: title,
    metadata: { priceMinor: price.minor, isActive: input.isActive, notes: noteIds.length, subjects: subjectIds.length },
    ctx: input.ctx,
  });

  return { message: input.isActive ? 'Saved. The bundle is live.' : 'Saved as a draft.' };
}

/** Deletes a bundle nobody has bought; one with orders can only be deactivated. */
export async function deleteBundle(input: { bundleId: string; actor: AdminActor; ctx?: RequestContext | null }): Promise<void> {
  const bundle = await prisma.bundle.findUnique({ where: { id: input.bundleId }, select: { id: true, title: true } });
  if (!bundle) throw Errors.notFound('That bundle no longer exists.');
  if ((await prisma.orderItem.count({ where: { bundleId: bundle.id } })) > 0) {
    throw Errors.conflict('This bundle has orders, so it is kept for the record. Make it inactive instead.');
  }
  await writeAudit({
    action: 'BUNDLE_DELETED',
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    targetType: 'bundle',
    targetId: bundle.id,
    targetLabel: bundle.title,
    ctx: input.ctx,
  });
  await prisma.bundle.delete({ where: { id: bundle.id } });
}
