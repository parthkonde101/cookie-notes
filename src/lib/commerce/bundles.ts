import 'server-only';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';
import { coverUrl } from '@/lib/catalog';
import { ownedNoteIds } from '@/lib/access/entitlements';
import { bundleSavings } from '@/lib/commerce/money';

/**
 * Bundles as the pages show them.
 *
 * One definition of "purchasable" for every surface (the subject page, the admin list and
 * checkout itself): the bundle is ACTIVE, holds at least two notes, and every one of those
 * notes is published. A bundle that fails it is simply not offered to students — never
 * shown with a Buy button that would then refuse.
 */

export interface BundleNoteView {
  id: string;
  title: string;
  priceMinor: number;
  isPaid: boolean;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  subjectName: string;
  owned: boolean;
}

export interface BundleView {
  id: string;
  title: string;
  description: string | null;
  priceMinor: number;
  isActive: boolean;
  isFeatured: boolean;
  position: number;
  cover: string | null;
  notes: BundleNoteView[];
  subjectIds: string[];
  /** Notes in the bundle the viewer already holds (never charged for twice in spirit — see the notice). */
  ownedCount: number;
  allOwned: boolean;
  savings: ReturnType<typeof bundleSavings>;
  /** Why it cannot be bought right now, or null when it can. */
  problem: string | null;
}

const bundleSelect = {
  id: true,
  title: true,
  description: true,
  priceMinor: true,
  isActive: true,
  isFeatured: true,
  position: true,
  coverSubject: { select: { id: true, coverStorageKey: true, coverUpdatedAt: true } },
  subjects: {
    select: {
      subjectId: true,
      subject: { select: { id: true, coverStorageKey: true, coverUpdatedAt: true } },
    },
  },
  items: {
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: {
      note: {
        select: {
          id: true,
          title: true,
          priceMinor: true,
          isPaid: true,
          status: true,
          unitId: true,
          subjectId: true,
          subject: { select: { name: true, semesterId: true } },
        },
      },
    },
  },
} satisfies Prisma.BundleSelect;

type RawBundle = Awaited<ReturnType<typeof loadRaw>>[number];

function loadRaw(where: Prisma.BundleWhereInput) {
  return prisma.bundle.findMany({
    where,
    select: bundleSelect,
    orderBy: [{ isFeatured: 'desc' }, { position: 'asc' }, { createdAt: 'asc' }],
  });
}

/** Why a bundle cannot be sold right now, or null. */
export function bundleProblem(bundle: { isActive: boolean; notes: { status: string }[] }): string | null {
  if (!bundle.isActive) return 'It is not active.';
  if (bundle.notes.length < 2) return 'A bundle needs at least two notes.';
  const unpublished = bundle.notes.filter((note) => note.status !== 'PUBLISHED').length;
  if (unpublished > 0) {
    return `${unpublished} ${unpublished === 1 ? 'note is' : 'notes are'} not published, so the bundle cannot be sold yet.`;
  }
  return null;
}

async function shape(raw: RawBundle[], viewerId: string | null): Promise<BundleView[]> {
  const everyNote = raw.flatMap((bundle) => bundle.items.map((item) => item.note));
  const owned = viewerId
    ? await ownedNoteIds(
        viewerId,
        everyNote.map((note) => ({
          id: note.id,
          unitId: note.unitId,
          subjectId: note.subjectId,
          semesterId: note.subject.semesterId,
        })),
      )
    : new Set<string>();

  return raw.map((bundle) => {
    const notes: BundleNoteView[] = bundle.items.map(({ note }) => ({
      id: note.id,
      title: note.title,
      priceMinor: note.priceMinor,
      isPaid: note.isPaid,
      status: note.status,
      subjectName: note.subject.name,
      owned: owned.has(note.id),
    }));
    const ownedCount = notes.filter((note) => note.owned).length;
    const coverSource = bundle.coverSubject ?? bundle.subjects[0]?.subject ?? null;
    return {
      id: bundle.id,
      title: bundle.title,
      description: bundle.description,
      priceMinor: bundle.priceMinor,
      isActive: bundle.isActive,
      isFeatured: bundle.isFeatured,
      position: bundle.position,
      cover: coverSource ? coverUrl(coverSource.id, coverSource.coverStorageKey, coverSource.coverUpdatedAt) : null,
      notes,
      subjectIds: bundle.subjects.map((row) => row.subjectId),
      ownedCount,
      allOwned: notes.length > 0 && ownedCount === notes.length,
      savings: bundleSavings(
        bundle.priceMinor,
        notes.map((note) => ({ isPaid: note.isPaid, priceMinor: note.priceMinor })),
      ),
      problem: bundleProblem({ isActive: bundle.isActive, notes }),
    };
  });
}

/**
 * The bundles to promote on one subject page: active and purchasable, featured first,
 * then in the admin's order. A bundle assigned to several subjects appears once on each
 * page (the join table cannot hold the same pair twice, and this reads one subject).
 */
export async function bundlesForSubject(subjectId: string, viewerId: string | null): Promise<BundleView[]> {
  const raw = await loadRaw({ isActive: true, subjects: { some: { subjectId } } });
  const views = await shape(raw, viewerId);
  return views.filter((bundle) => bundle.problem === null);
}

/** One bundle in full, for the admin editor and the preview. */
export async function bundleForAdmin(id: string): Promise<BundleView | null> {
  const [raw] = await loadRaw({ id });
  if (!raw) return null;
  return (await shape([raw], null))[0];
}

/** Every bundle, for the admin list. */
export async function allBundlesForAdmin(): Promise<BundleView[]> {
  return shape(await loadRaw({}), null);
}
