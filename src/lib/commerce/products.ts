import 'server-only';
import { prisma } from '@/lib/prisma';
import { Errors } from '@/lib/errors';
import { CURRENCY, MAX_PRICE_MINOR, MIN_PRICE_MINOR } from '@/lib/commerce/money';
import { ownedNoteIds } from '@/lib/access/entitlements';

/**
 * Resolving "what is being bought" — always on the server, always from the database.
 *
 * The browser sends a product type and an id and nothing else. The price, the
 * currency, the title and the exact notes delivered are all decided here, so no
 * request can name an amount or smuggle in a note.
 */

/** One note as it will be delivered and as it is recorded on the order item. */
export interface ContentSnapshot {
  noteId: string;
  title: string;
  subjectId: string;
  priceMinor: number;
}

export interface ResolvedProduct {
  type: 'NOTE' | 'BUNDLE';
  /** The note's or the bundle's own id. */
  productId: string;
  title: string;
  unitPriceMinor: number;
  currency: typeof CURRENCY;
  contents: ContentSnapshot[];
  /** How many of `contents` this student already holds (never charged for twice in spirit). */
  alreadyOwned: ContentSnapshot[];
}

const noteSale = {
  id: true,
  title: true,
  status: true,
  isPaid: true,
  priceMinor: true,
  unitId: true,
  subjectId: true,
  subject: { select: { semesterId: true, isArchived: true } },
} as const;

/**
 * A single note for sale, or a thrown, user-safe explanation of why it cannot be.
 * "Not for sale" and "does not exist" answer alike, so the endpoint cannot be used
 * to enumerate notes.
 */
export async function resolveNoteProduct(noteId: string, userId: string): Promise<ResolvedProduct> {
  const note = await prisma.note.findUnique({ where: { id: noteId }, select: noteSale });
  const unavailable = () => Errors.notFound('This note is not available to buy.');

  if (!note || note.status !== 'PUBLISHED' || note.subject.isArchived) throw unavailable();
  if (!note.isPaid || note.priceMinor < MIN_PRICE_MINOR || note.priceMinor > MAX_PRICE_MINOR) {
    throw unavailable();
  }

  const owned = await ownedNoteIds(userId, [
    { id: note.id, unitId: note.unitId, subjectId: note.subjectId, semesterId: note.subject.semesterId },
  ]);
  if (owned.has(note.id)) {
    throw Errors.conflict('You already have this note.', { code: 'already_owned' });
  }

  const snapshot: ContentSnapshot = {
    noteId: note.id,
    title: note.title,
    subjectId: note.subjectId,
    priceMinor: note.priceMinor,
  };
  return {
    type: 'NOTE',
    productId: note.id,
    title: note.title,
    unitPriceMinor: note.priceMinor,
    currency: CURRENCY,
    contents: [snapshot],
    alreadyOwned: [],
  };
}

/**
 * A bundle for sale. It is only purchasable while it is ACTIVE, holds at least two
 * notes, has a price in range, and EVERY note in it is currently published — a
 * student is never sold "five notes" and handed four.
 */
export async function resolveBundleProduct(bundleId: string, userId: string): Promise<ResolvedProduct> {
  const bundle = await prisma.bundle.findUnique({
    where: { id: bundleId },
    select: {
      id: true,
      title: true,
      priceMinor: true,
      currency: true,
      isActive: true,
      items: {
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { note: { select: noteSale } },
      },
    },
  });
  const unavailable = () => Errors.notFound('This bundle is not available to buy.');

  if (!bundle || !bundle.isActive || bundle.currency !== CURRENCY) throw unavailable();
  if (bundle.priceMinor < MIN_PRICE_MINOR || bundle.priceMinor > MAX_PRICE_MINOR) throw unavailable();
  if (bundle.items.length < 2) throw unavailable();
  if (bundle.items.some((item) => item.note.status !== 'PUBLISHED' || item.note.subject.isArchived)) {
    throw Errors.conflict('This bundle is temporarily unavailable while one of its notes is being updated.', {
      code: 'bundle_unavailable',
    });
  }

  const contents: ContentSnapshot[] = bundle.items.map(({ note }) => ({
    noteId: note.id,
    title: note.title,
    subjectId: note.subjectId,
    priceMinor: note.priceMinor,
  }));

  const owned = await ownedNoteIds(
    userId,
    bundle.items.map(({ note }) => ({
      id: note.id,
      unitId: note.unitId,
      subjectId: note.subjectId,
      semesterId: note.subject.semesterId,
    })),
  );
  const alreadyOwned = contents.filter((content) => owned.has(content.noteId));
  if (alreadyOwned.length === contents.length) {
    throw Errors.conflict('You already have every note in this bundle.', { code: 'already_owned' });
  }

  return {
    type: 'BUNDLE',
    productId: bundle.id,
    title: bundle.title,
    unitPriceMinor: bundle.priceMinor,
    currency: CURRENCY,
    contents,
    alreadyOwned,
  };
}

export function resolveProduct(type: 'NOTE' | 'BUNDLE', productId: string, userId: string) {
  return type === 'NOTE' ? resolveNoteProduct(productId, userId) : resolveBundleProduct(productId, userId);
}
